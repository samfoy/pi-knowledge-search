import * as fs from "node:fs";
import * as path from "node:path";
import Assembler from "stream-json/assembler.js";
import makeParser from "stream-json/index.js";
import type { Config } from "./config.js";
import type { Embedder } from "./embedder.js";
import { chunkMarkdown, type Chunk } from "./chunker.js";
import { FtsChunkIndex, type FtsChunk } from "./fts-index.js";

interface IndexEntry {
  /** Relative path from its source directory root */
  relPath: string;
  /** Which source directory this belongs to */
  sourceDir: string;
  /** File mtime (ms) at time of indexing */
  mtime: number;
  /** Embedding vector */
  vector: number[];
  /** This chunk's content for excerpt display */
  excerpt: string;
  /** Section heading this chunk falls under */
  heading: string;
  /** Chunk index (0, 1, 2... for multi-chunk files) */
  chunkIndex: number;
}

interface IndexData {
  version: number;
  dimensions: number;
  entries: Record<string, IndexEntry>; // keyed by "absPath#chunkIndex"
}

export interface SearchResult {
  /** Absolute file path */
  path: string;
  /** Cosine similarity score (0-1) */
  score: number;
  /** Content excerpt (the matched chunk) */
  excerpt: string;
  /** Section heading for context */
  heading: string;
}

const INDEX_VERSION = 3; // Bumped from 2 for chunk support
const MAX_EXCERPT_LENGTH = 3500; // Safety cap for stored excerpts

export class KnowledgeIndex {
  private config: Config;
  private embedder: Embedder;
  private data: IndexData;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private fts: FtsChunkIndex;

  constructor(config: Config, embedder: Embedder) {
    this.config = config;
    this.embedder = embedder;
    this.data = {
      version: INDEX_VERSION,
      dimensions: config.dimensions,
      entries: {},
    };
    this.fts = new FtsChunkIndex(config.indexDir);
  }

  size(): number {
    // Count unique file paths (not chunks)
    const paths = new Set<string>();
    for (const entry of Object.values(this.data.entries)) {
      paths.add(`${entry.sourceDir}/${entry.relPath}`);
    }
    return paths.size;
  }

  chunkCount(): number {
    return Object.keys(this.data.entries).length;
  }

  /**
   * Threshold above which the load/save paths switch to streaming. V8's
   * string length limit is ~512MB (2^29 - 24 bytes on 64-bit). A single
   * call to `readFileSync(path, "utf-8")` or `JSON.stringify(hugeObject)`
   * throws `RangeError: Invalid string length` once that limit is hit.
   *
   * Below this threshold we use the straightforward sync paths since they
   * are an order of magnitude faster. Above it we switch to streaming.
   *
   * Set to 256MB to give a generous safety margin below the hard cliff.
   */
  private static readonly STREAMING_THRESHOLD_BYTES = 256 * 1024 * 1024;

  /**
   * Load the index from disk.
   *
   * Uses a fast sync path (`readFileSync` + `JSON.parse`) for normal-sized
   * indexes and automatically falls back to a streaming reader for files
   * large enough to risk V8's string length limit (`RangeError: Invalid
   * string length`).
   *
   * If the file is missing, corrupt, or from an incompatible version, falls
   * back to an empty index and returns — callers will then trigger a full
   * re-index. Never throws.
   */
  async load(): Promise<void> {
    this.fts.load();

    const indexFile = path.join(this.config.indexDir, "index.json");
    if (fs.existsSync(indexFile)) {
      try {
        let parsed: IndexData | null = null;
        const size = fs.statSync(indexFile).size;
        if (size >= KnowledgeIndex.STREAMING_THRESHOLD_BYTES) {
          parsed = await this.streamLoadJson(indexFile);
        } else {
          const raw = fs.readFileSync(indexFile, "utf-8");
          parsed = JSON.parse(raw) as IndexData;
        }
        if (
          parsed &&
          parsed.version === INDEX_VERSION &&
          parsed.dimensions === this.config.dimensions
        ) {
          this.data = parsed;
        }
        // Version or dimension mismatch → keep fresh data, caller will re-index.
      } catch {
        // Corrupt file / partial write / IO error → fresh index.
      }
    }

    // Backfill FTS side-car from the vector index when it's empty but the
    // JSON index is populated. Handles first-run upgrades from pre-hybrid
    // versions without forcing a full re-embed.
    const chunkCount = this.chunkCount();
    if (chunkCount > 0 && this.fts.count() === 0) {
      this.rebuildFtsFromEntries();
    }
  }

  /**
   * Repopulate the FTS side-car from the in-memory JSON entries. Used on
   * first load after upgrading to hybrid search so existing users don't
   * pay the cost of re-embedding just to get keyword search.
   */
  private rebuildFtsFromEntries(): void {
    const chunks: FtsChunk[] = [];
    for (const [key, entry] of Object.entries(this.data.entries)) {
      chunks.push({
        key,
        absPath: this.absPathFromKey(key),
        relPath: entry.relPath,
        sourceDir: entry.sourceDir,
        heading: entry.heading,
        content: entry.excerpt,
        chunkIndex: entry.chunkIndex,
        mtime: entry.mtime,
      });
    }
    if (chunks.length > 0) this.fts.upsertMany(chunks);
  }

  private streamLoadJson(file: string): Promise<IndexData | null> {
    return new Promise((resolve, reject) => {
      const stream = fs.createReadStream(file, { highWaterMark: 256 * 1024 });
      const parser = makeParser();
      const assembler = Assembler.connectTo(parser);

      let settled = false;
      const settle = (ok: () => void, err?: (e: Error) => void) => {
        if (settled) return;
        settled = true;
        if (err) err(new Error("assembler failed"));
        else ok();
      };

      assembler.on("done", (asm) => {
        settle(() => resolve(asm.current as IndexData));
      });
      stream.on("error", (e) => settle(() => resolve(null), () => reject(e)));
      parser.on("error", (e) => settle(() => resolve(null), () => reject(e)));

      stream.pipe(parser);
    });
  }


  /**
   * Persist the index to disk.
   *
   * Fast path: `JSON.stringify` + `writeFile`, wrapped in an atomic rename
   * from `index.json.tmp`. This handles all normal-sized indexes in one shot.
   *
   * Fallback path: if `JSON.stringify` throws `RangeError: Invalid string
   * length` (V8's ~512MB string limit), fall back to streaming the JSON out
   * block by block via `createWriteStream`. This path never materialises the
   * full serialised form as a single string.
   *
   * Either way the write is atomic: content goes to `index.json.tmp` first,
   * then renamed over `index.json` once fully flushed. A crash mid-write
   * leaves the previous `index.json` intact.
   */
  private async save(): Promise<void> {
    fs.mkdirSync(this.config.indexDir, { recursive: true });
    const finalFile = path.join(this.config.indexDir, "index.json");
    const tmpFile = finalFile + ".tmp";

    try {
      let serialised: string;
      try {
        serialised = JSON.stringify(this.data);
      } catch (err) {
        if (err instanceof RangeError) {
          await this.saveStreaming(tmpFile);
          await fs.promises.rename(tmpFile, finalFile);
          this.dirty = false;
          return;
        }
        throw err;
      }
      await fs.promises.writeFile(tmpFile, serialised);
      await fs.promises.rename(tmpFile, finalFile);
      this.dirty = false;
    } catch (err) {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // best-effort cleanup
      }
      throw err;
    }
  }

  /**
   * Streaming fallback used when the index is too big for `JSON.stringify`
   * to produce a single string. Writes key-by-key through a write stream so
   * no intermediate giant string is ever materialised.
   */
  private async saveStreaming(tmpFile: string): Promise<void> {
    const stream = fs.createWriteStream(tmpFile);
    let streamError: Error | null = null;
    stream.once("error", (err) => {
      streamError = err;
    });

    const write = (chunk: string): Promise<void> =>
      new Promise((resolve, reject) => {
        if (streamError) {
          reject(streamError);
          return;
        }
        if (stream.write(chunk)) {
          resolve();
        } else {
          stream.once("drain", () => (streamError ? reject(streamError) : resolve()));
        }
      });

    try {
      await write(
        `{"version":${JSON.stringify(this.data.version)},` +
          `"dimensions":${JSON.stringify(this.data.dimensions)},` +
          `"entries":{`
      );
      let first = true;
      for (const key of Object.keys(this.data.entries)) {
        const entry = this.data.entries[key];
        const prefix = first ? "" : ",";
        first = false;
        await write(`${prefix}${JSON.stringify(key)}:${JSON.stringify(entry)}`);
      }
      await write("}}");
    } catch (err) {
      stream.destroy();
      throw err;
    }

    await new Promise<void>((resolve, reject) => {
      stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }

  scheduleSave(): void {
    if (this.saveTimer) return;
    this.dirty = true;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.dirty) {
        void this.save().catch((err) => {
          console.error(`knowledge-search: scheduled save failed: ${(err as Error).message}`);
        });
      }
    }, 5000);
  }

  /**
   * Build the entry key for a file chunk.
   */
  private entryKey(absPath: string, chunkIndex: number): string {
    return `${absPath}#${chunkIndex}`;
  }

  /**
   * Get the absolute path from an entry key (strip #chunkIndex).
   */
  private absPathFromKey(key: string): string {
    const hashIdx = key.lastIndexOf("#");
    return hashIdx >= 0 ? key.slice(0, hashIdx) : key;
  }

  /**
   * Remove all chunks for a given absolute file path from both the vector
   * store and the FTS side-car.
   */
  private removeAllChunks(absPath: string): number {
    const prefix = absPath + "#";
    const toRemove: string[] = [];
    for (const key of Object.keys(this.data.entries)) {
      if (key.startsWith(prefix)) {
        toRemove.push(key);
      }
    }
    for (const key of toRemove) {
      delete this.data.entries[key];
    }
    // Always clear FTS rows for this path too — FTS may hold entries even
    // when the vector side doesn't (e.g. if a previous embed batch failed).
    try {
      this.fts.deleteByAbsPath(absPath);
    } catch {
      // FTS not loaded yet — nothing to remove.
    }
    return toRemove.length;
  }

  /**
   * Prepare embedding text for a chunk with title context.
   */
  private chunkEmbedText(relPath: string, heading: string, chunkText: string): string {
    const title = relPath.replace(/\.[^.]+$/, "").replace(/\//g, " > ");
    const sectionContext = heading && heading !== "intro" ? ` > ${heading}` : "";
    return `Title: ${title}${sectionContext}\n\n${chunkText}`;
  }

  /**
   * Scan all configured directories, find new/changed/removed files, update index.
   */
  async sync(): Promise<{ added: number; updated: number; removed: number }> {
    const allFiles = this.scanAllFiles();
    const currentPaths = new Set(allFiles.map((f) => f.absPath));

    // Remove entries for files that no longer exist
    let removed = 0;
    const seenRemoved = new Set<string>();
    for (const key of Object.keys(this.data.entries)) {
      const absPath = this.absPathFromKey(key);
      if (!currentPaths.has(absPath) && !seenRemoved.has(absPath)) {
        seenRemoved.add(absPath);
        removed += 1;
        this.removeAllChunks(absPath);
      }
    }

    // Find new or updated files
    const toProcess: {
      absPath: string;
      relPath: string;
      sourceDir: string;
      mtime: number;
      content: string;
      chunks: Chunk[];
    }[] = [];

    for (const file of allFiles) {
      // Check if any chunk exists for this file with current mtime
      const existingKey = this.entryKey(file.absPath, 0);
      const existing = this.data.entries[existingKey];
      if (existing && existing.mtime >= file.mtime) continue;

      const content = this.readFileContent(file.absPath);
      if (!content || content.trim().length <= 20) continue;

      const chunks = chunkMarkdown(content);
      if (chunks.length === 0) continue;

      toProcess.push({ ...file, content, chunks });
    }

    let added = 0;
    let updated = 0;

    if (toProcess.length > 0) {
      // Flatten all chunks for batch embedding
      const allChunkTexts: string[] = [];
      const chunkMeta: { fileIdx: number; chunkIdx: number }[] = [];

      for (let fi = 0; fi < toProcess.length; fi++) {
        const file = toProcess[fi];
        for (let ci = 0; ci < file.chunks.length; ci++) {
          const chunk = file.chunks[ci];
          allChunkTexts.push(this.chunkEmbedText(file.relPath, chunk.heading, chunk.text));
          chunkMeta.push({ fileIdx: fi, chunkIdx: ci });
        }
      }

      // Embed in batches
      const BATCH_SIZE = 50;
      const allVectors: (number[] | null)[] = new Array(allChunkTexts.length).fill(null);

      for (let i = 0; i < allChunkTexts.length; i += BATCH_SIZE) {
        const batchTexts = allChunkTexts.slice(i, i + BATCH_SIZE);
        const vectors = await this.embedder.embedBatch(batchTexts);
        for (let j = 0; j < vectors.length; j++) {
          allVectors[i + j] = vectors[j];
        }
      }

      // Store results, grouped by file
      const processedFiles = new Set<number>();

      for (let i = 0; i < chunkMeta.length; i++) {
        const { fileIdx, chunkIdx } = chunkMeta[i];
        const vector = allVectors[i];
        if (!vector) continue;

        const file = toProcess[fileIdx];

        // On first chunk of a file, remove old chunks and track add/update
        if (!processedFiles.has(fileIdx)) {
          processedFiles.add(fileIdx);
          const hadExisting = this.removeAllChunks(file.absPath) > 0;
          if (hadExisting) updated++;
          else added++;
        }

        const chunk = file.chunks[chunkIdx];
        const key = this.entryKey(file.absPath, chunkIdx);
        const excerpt = chunk.text.slice(0, MAX_EXCERPT_LENGTH);
        this.data.entries[key] = {
          relPath: file.relPath,
          sourceDir: file.sourceDir,
          mtime: file.mtime,
          vector,
          excerpt,
          heading: chunk.heading,
          chunkIndex: chunkIdx,
        };
        this.fts.upsert({
          key,
          absPath: file.absPath,
          relPath: file.relPath,
          sourceDir: file.sourceDir,
          heading: chunk.heading,
          content: excerpt,
          chunkIndex: chunkIdx,
          mtime: file.mtime,
        });
      }
    }

    if (added + updated + removed > 0) {
      await this.save();
    }

    return { added, updated, removed };
  }

  async rebuild(): Promise<void> {
    this.data.entries = {};
    try {
      this.fts.clear();
    } catch {
      // FTS not loaded — sync will populate it.
    }
    await this.sync();
  }

  /**
   * Pure vector search. Retained as an escape hatch for callers that
   * explicitly want cosine-only ranking (tests, A/B comparisons).
   *
   * In the `knowledge_search` tool path we call `search()` below, which
   * delegates to `hybridSearch()` by default.
   */
  async vectorSearch(
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    const queryVector = await this.embedder.embed(query, signal);

    const scored: { key: string; absPath: string; score: number }[] = [];
    for (const [key, entry] of Object.entries(this.data.entries)) {
      if (!entry.vector) continue;
      const score = dotProduct(queryVector, entry.vector);
      scored.push({ key, absPath: this.absPathFromKey(key), score });
    }

    scored.sort((a, b) => b.score - a.score);

    // Deduplicate: keep only the best-scoring chunk per file
    const seenPaths = new Set<string>();
    const deduped: { key: string; absPath: string; score: number }[] = [];

    for (const item of scored) {
      if (seenPaths.has(item.absPath)) continue;
      seenPaths.add(item.absPath);
      deduped.push(item);
      if (deduped.length >= limit) break;
    }

    return deduped
      .filter((s) => s.score > 0.15)
      .map((s) => {
        const entry = this.data.entries[s.key];
        return {
          path: s.absPath,
          score: s.score,
          excerpt: entry.excerpt,
          heading: entry.heading,
        };
      });
  }

  /**
   * Default search path used by the `knowledge_search` tool. Delegates to
   * hybrid (vector + BM25 fused via Reciprocal Rank Fusion).
   */
  async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
    return this.hybridSearch(query, limit, signal);
  }

  /**
   * Hybrid search: cosine embeddings + FTS5 BM25, fused via Reciprocal Rank
   * Fusion (k=60). Falls back gracefully:
   *   - no FTS hits or empty side-car → pure vector
   *   - embedding call fails (network blip, rate limit) → pure BM25
   *   - both fail → empty
   *
   * Deduplicates so only the best chunk per file is returned.
   */
  async hybridSearch(
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    const K = 60;
    // Pool size: pull 5× the requested limit from each backend so RRF has
    // enough candidates to rerank across. Matches session-search tuning.
    const poolSize = Math.max(limit * 5, 50);

    // Kick off both searches in parallel. Catch individually so one backend
    // failing doesn't take down the other.
    const vecPromise = this.runVectorRanks(query, poolSize, signal).catch((err) => {
      // Surface a readable hint on first failure; swallow otherwise.
      if (process.env.KNOWLEDGE_SEARCH_DEBUG) {
        console.error(`knowledge-search: vector search failed: ${(err as Error).message}`);
      }
      return new Map<string, number>();
    });
    let ftsRanks: Map<string, number>;
    try {
      ftsRanks = this.fts.searchRanks(query, poolSize);
    } catch {
      ftsRanks = new Map();
    }
    const vecRanks = await vecPromise;

    if (vecRanks.size === 0 && ftsRanks.size === 0) return [];

    // RRF fusion: score = Σ 1 / (k + rank) across all backends that hit this key.
    // Count active backends so the display scaling below makes sense when one
    // backend short-circuits (pure-BM25 fallback, vector-only fallback).
    const activeBackends =
      (vecRanks.size > 0 ? 1 : 0) + (ftsRanks.size > 0 ? 1 : 0);
    const fused = new Map<string, number>();
    for (const [key, r] of vecRanks) {
      fused.set(key, (fused.get(key) ?? 0) + 1 / (K + r));
    }
    for (const [key, r] of ftsRanks) {
      fused.set(key, (fused.get(key) ?? 0) + 1 / (K + r));
    }

    // Scale for display: theoretical max RRF score when every active backend
    // ranks a key at position 1 is `activeBackends / (K + 1)`. Dividing by
    // that max maps a perfect hit to 1.0, keeping the existing
    // `(score * 100).toFixed(1)`-based "X% match" UI meaningful.
    const displayScale = (K + 1) / Math.max(activeBackends, 1);

    // Rank by fused score.
    const sorted = [...fused.entries()].sort((a, b) => b[1] - a[1]);

    // Dedup: keep only the best chunk per file.
    const seen = new Set<string>();
    const out: SearchResult[] = [];
    for (const [key, score] of sorted) {
      const entry = this.data.entries[key];
      // Key might exist in FTS but not in vector store if vector side is
      // stale. Look up excerpt/heading via FTS fallback in that case.
      const absPath = this.absPathFromKey(key);
      if (seen.has(absPath)) continue;
      seen.add(absPath);
      const scaledScore = Math.min(score * displayScale, 1);
      if (entry) {
        out.push({
          path: absPath,
          score: scaledScore,
          excerpt: entry.excerpt,
          heading: entry.heading,
        });
      } else {
        // Vector-less — synthesise from whatever FTS has.
        out.push({
          path: absPath,
          score: scaledScore,
          excerpt: "",
          heading: "",
        });
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Run the vector side of hybrid search and return ranked keys as a
   * Map<key, rank> (1-based). Kept internal — `vectorSearch()` is the
   * public escape hatch.
   */
  private async runVectorRanks(
    query: string,
    poolSize: number,
    signal?: AbortSignal,
  ): Promise<Map<string, number>> {
    const queryVector = await this.embedder.embed(query, signal);
    const scored: { key: string; score: number }[] = [];
    for (const [key, entry] of Object.entries(this.data.entries)) {
      if (!entry.vector) continue;
      const score = dotProduct(queryVector, entry.vector);
      // Mirror the existing 0.15 floor from vectorSearch so noise doesn't
      // pollute RRF candidates.
      if (score <= 0.15) continue;
      scored.push({ key, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const out = new Map<string, number>();
    const n = Math.min(scored.length, poolSize);
    for (let i = 0; i < n; i++) out.set(scored[i].key, i + 1);
    return out;
  }

  /**
   * Update a single file in the index (called by watcher).
   */
  async updateFile(absPath: string, sourceDir: string): Promise<void> {
    if (!fs.existsSync(absPath)) {
      this.removeFile(absPath);
      return;
    }

    const relPath = path.relative(sourceDir, absPath);
    if (this.shouldSkip(relPath, path.basename(absPath))) return;

    const stat = fs.statSync(absPath);
    const content = this.readFileContent(absPath);
    if (!content || content.trim().length <= 20) {
      this.removeFile(absPath);
      return;
    }

    const chunks = chunkMarkdown(content);
    if (chunks.length === 0) {
      this.removeFile(absPath);
      return;
    }

    // Remove old chunks for this file
    this.removeAllChunks(absPath);

    // Embed and store each chunk
    const texts = chunks.map((c) => this.chunkEmbedText(relPath, c.heading, c.text));
    const vectors = await this.embedder.embedBatch(texts);

    for (let i = 0; i < chunks.length; i++) {
      const vector = vectors[i];
      if (!vector) continue;

      const key = this.entryKey(absPath, i);
      const excerpt = chunks[i].text.slice(0, MAX_EXCERPT_LENGTH);
      this.data.entries[key] = {
        relPath,
        sourceDir,
        mtime: stat.mtimeMs,
        vector,
        excerpt,
        heading: chunks[i].heading,
        chunkIndex: i,
      };
      this.fts.upsert({
        key,
        absPath,
        relPath,
        sourceDir,
        heading: chunks[i].heading,
        content: excerpt,
        chunkIndex: i,
        mtime: stat.mtimeMs,
      });
    }
    this.scheduleSave();
  }

  removeFile(absPath: string): void {
    const removed = this.removeAllChunks(absPath);
    if (removed > 0) {
      this.scheduleSave();
    }
  }

  /** Alias for removeFile — removes all data for a file path. */
  deleteFile(absPath: string): void {
    this.removeFile(absPath);
  }

  /** Flush pending saves and release resources. Awaits any in-flight save. */
  async close(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) {
      await this.save();
    }
    try {
      this.fts.close();
    } catch {
      // already closed
    }
  }

  // -----------------------------------------------------------------------
  // Scanning
  // -----------------------------------------------------------------------

  private scanAllFiles(): {
    absPath: string;
    relPath: string;
    sourceDir: string;
    mtime: number;
  }[] {
    const results: {
      absPath: string;
      relPath: string;
      sourceDir: string;
      mtime: number;
    }[] = [];

    for (const dir of this.config.dirs) {
      this.walkDir(dir, dir, results);
    }
    return results;
  }

  private walkDir(
    currentDir: string,
    sourceDir: string,
    results: {
      absPath: string;
      relPath: string;
      sourceDir: string;
      mtime: number;
    }[]
  ): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (this.config.excludeDirs.includes(entry.name) || entry.name.startsWith(".")) {
          continue;
        }
        this.walkDir(absPath, sourceDir, results);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (!this.config.fileExtensions.includes(ext)) continue;
        const relPath = path.relative(sourceDir, absPath);
        if (this.shouldSkip(relPath, entry.name)) continue;
        try {
          const stat = fs.statSync(absPath);
          results.push({ absPath, relPath, sourceDir, mtime: stat.mtimeMs });
        } catch {
          // Skip unreadable
        }
      }
    }
  }

  private shouldSkip(relPath: string, _basename: string): boolean {
    const parts = relPath.split(path.sep);
    for (const part of parts) {
      if (this.config.excludeDirs.includes(part) || part.startsWith(".")) {
        return true;
      }
    }
    return false;
  }

  private readFileContent(absPath: string): string | null {
    try {
      const content = fs.readFileSync(absPath, "utf-8");
      // Strip YAML frontmatter if present (common in markdown)
      return content.replace(/^---\n[\s\S]*?\n---\n?/, "");
    } catch {
      return null;
    }
  }
}

/** Dot product — works as cosine similarity when vectors are pre-normalized. */
export function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

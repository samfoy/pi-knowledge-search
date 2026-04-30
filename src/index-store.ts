import * as fs from "node:fs";
import * as path from "node:path";
import type { Config } from "./config";
import type { Embedder } from "./embedder";
import { chunkMarkdown, type Chunk } from "./chunker";

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

  constructor(config: Config, embedder: Embedder) {
    this.config = config;
    this.embedder = embedder;
    this.data = {
      version: INDEX_VERSION,
      dimensions: config.dimensions,
      entries: {},
    };
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

  loadSync(): void {
    const indexFile = path.join(this.config.indexDir, "index.json");
    if (fs.existsSync(indexFile)) {
      try {
        const raw = fs.readFileSync(indexFile, "utf-8");
        const parsed = JSON.parse(raw) as IndexData;
        if (parsed.version === INDEX_VERSION && parsed.dimensions === this.config.dimensions) {
          this.data = parsed;
        }
        // Old version or dimension mismatch → start fresh (triggers re-index)
      } catch {
        // Corrupted — start fresh
      }
    }
  }

  async load(): Promise<void> {
    this.loadSync();
  }

  private save(): void {
    fs.mkdirSync(this.config.indexDir, { recursive: true });
    const indexFile = path.join(this.config.indexDir, "index.json");
    fs.writeFileSync(indexFile, JSON.stringify(this.data));
    this.dirty = false;
  }

  scheduleSave(): void {
    if (this.saveTimer) return;
    this.dirty = true;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.dirty) this.save();
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
   * Remove all chunks for a given absolute file path.
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
        this.data.entries[key] = {
          relPath: file.relPath,
          sourceDir: file.sourceDir,
          mtime: file.mtime,
          vector,
          excerpt: chunk.text.slice(0, MAX_EXCERPT_LENGTH),
          heading: chunk.heading,
          chunkIndex: chunkIdx,
        };
      }
    }

    if (added + updated + removed > 0) {
      this.save();
    }

    return { added, updated, removed };
  }

  async rebuild(): Promise<void> {
    this.data.entries = {};
    await this.sync();
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
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
      this.data.entries[key] = {
        relPath,
        sourceDir,
        mtime: stat.mtimeMs,
        vector,
        excerpt: chunks[i].text.slice(0, MAX_EXCERPT_LENGTH),
        heading: chunks[i].heading,
        chunkIndex: i,
      };
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

  /** Flush pending saves and release resources. */
  close(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) {
      this.save();
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

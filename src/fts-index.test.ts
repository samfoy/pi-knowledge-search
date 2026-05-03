import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { KnowledgeIndex } from "./index-store.js";
import { FtsChunkIndex, toFtsQuery } from "./fts-index.js";
import type { Config } from "./config.js";
import type { Embedder } from "./embedder.js";

// ---------------------------------------------------------------------------
// FTS side-car + hybrid search
// ---------------------------------------------------------------------------

function makeConfig(dir: string, dimensions = 4): Config {
  return {
    dirs: ["/tmp/does-not-matter"],
    fileExtensions: [".md"],
    excludeDirs: [],
    dimensions,
    provider: null,
    indexDir: dir,
    knowledgeBases: [],
  };
}

/**
 * Deterministic stub embedder that returns vectors from a predefined table.
 * Lets us assert exact ranking without depending on a real provider.
 */
class TableEmbedder implements Embedder {
  constructor(private table: Record<string, number[]>) {}
  async embed(text: string): Promise<number[]> {
    const v = this.table[text];
    if (!v) throw new Error(`TableEmbedder: no vector for "${text}"`);
    return v;
  }
  async embedBatch(texts: string[]): Promise<(number[] | null)[]> {
    return texts.map((t) => this.table[t] ?? null);
  }
}

describe("toFtsQuery", () => {
  it("strips FTS syntax characters", () => {
    assert.equal(toFtsQuery('hello *world*'), '"hello" "world"');
    assert.equal(toFtsQuery('"quoted" (paren)'), '"quoted" "paren"');
  });

  it("joins terms with implicit AND (space)", () => {
    assert.equal(toFtsQuery("auth flow login"), '"auth" "flow" "login"');
  });

  it("returns empty string for empty/whitespace query", () => {
    assert.equal(toFtsQuery(""), "");
    assert.equal(toFtsQuery("   "), "");
  });

  it("preserves unicode words", () => {
    assert.equal(toFtsQuery("café journal"), '"café" "journal"');
  });
});

describe("FtsChunkIndex", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ks-fts-"));
  });

  beforeEach(() => {
    for (const f of fs.readdirSync(tmpDir)) {
      fs.rmSync(path.join(tmpDir, f), { force: true });
    }
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("upserts and searches chunks by keyword", () => {
    const fts = new FtsChunkIndex(tmpDir);
    fts.load();
    fts.upsert({
      key: "/vault/auth.md#0",
      absPath: "/vault/auth.md",
      relPath: "auth.md",
      sourceDir: "/vault",
      heading: "Auth",
      content: "OAuth authentication flow with JWT refresh",
      chunkIndex: 0,
      mtime: 1,
    });
    fts.upsert({
      key: "/vault/dogs.md#0",
      absPath: "/vault/dogs.md",
      relPath: "dogs.md",
      sourceDir: "/vault",
      heading: "Dogs",
      content: "Dog breeds and training tips",
      chunkIndex: 0,
      mtime: 1,
    });
    const hits = fts.search("authentication", 10);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].key, "/vault/auth.md#0");
    assert.ok(hits[0].score > 0, "score should be positive");
    fts.close();
  });

  it("searchRanks returns rank 1 for best match", () => {
    const fts = new FtsChunkIndex(tmpDir);
    fts.load();
    fts.upsert({
      key: "a#0",
      absPath: "/a.md",
      relPath: "a.md",
      sourceDir: "/",
      heading: "",
      content: "foo bar baz",
      chunkIndex: 0,
      mtime: 1,
    });
    fts.upsert({
      key: "b#0",
      absPath: "/b.md",
      relPath: "b.md",
      sourceDir: "/",
      heading: "",
      content: "foo",
      chunkIndex: 0,
      mtime: 1,
    });
    const ranks = fts.searchRanks("foo", 10);
    assert.ok(ranks.has("a#0") || ranks.has("b#0"));
    // Verify ranks are 1-based contiguous
    const values = [...ranks.values()].sort();
    assert.deepEqual(values, [1, 2]);
    fts.close();
  });

  it("deleteByAbsPath removes all chunks for a file", () => {
    const fts = new FtsChunkIndex(tmpDir);
    fts.load();
    for (let i = 0; i < 3; i++) {
      fts.upsert({
        key: `/vault/doc.md#${i}`,
        absPath: "/vault/doc.md",
        relPath: "doc.md",
        sourceDir: "/vault",
        heading: `Section ${i}`,
        content: `chunk ${i} content about widgets`,
        chunkIndex: i,
        mtime: 1,
      });
    }
    fts.upsert({
      key: "/vault/other.md#0",
      absPath: "/vault/other.md",
      relPath: "other.md",
      sourceDir: "/vault",
      heading: "",
      content: "other widgets content",
      chunkIndex: 0,
      mtime: 1,
    });
    assert.equal(fts.count(), 4);
    const removed = fts.deleteByAbsPath("/vault/doc.md");
    assert.equal(removed, 3);
    assert.equal(fts.count(), 1);
    assert.equal(fts.fileCount(), 1);
    fts.close();
  });

  it("upsert is idempotent (same key replaces)", () => {
    const fts = new FtsChunkIndex(tmpDir);
    fts.load();
    for (let i = 0; i < 5; i++) {
      fts.upsert({
        key: "k#0",
        absPath: "/f.md",
        relPath: "f.md",
        sourceDir: "/",
        heading: "",
        content: `version ${i}`,
        chunkIndex: 0,
        mtime: i,
      });
    }
    assert.equal(fts.count(), 1);
    const hits = fts.search("version", 10);
    assert.equal(hits.length, 1);
    assert.ok(hits[0].content.includes("4"));
    fts.close();
  });

  it("persists across reopens (survives close/load)", () => {
    const fts1 = new FtsChunkIndex(tmpDir);
    fts1.load();
    fts1.upsert({
      key: "a#0",
      absPath: "/a.md",
      relPath: "a.md",
      sourceDir: "/",
      heading: "",
      content: "persistent data",
      chunkIndex: 0,
      mtime: 1,
    });
    fts1.close();

    const fts2 = new FtsChunkIndex(tmpDir);
    fts2.load();
    assert.equal(fts2.count(), 1);
    assert.equal(fts2.search("persistent", 10).length, 1);
    fts2.close();
  });
});

describe("KnowledgeIndex hybrid search", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ks-hybrid-"));
  });

  beforeEach(() => {
    for (const f of fs.readdirSync(tmpDir)) {
      fs.rmSync(path.join(tmpDir, f), { force: true });
    }
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Seed an index with pre-populated entries (bypassing the embed pipeline).
   * The FTS side-car gets backfilled by `load()` when it's empty.
   */
  function seed(
    index: KnowledgeIndex,
    entries: Array<{
      absPath: string;
      chunkIndex?: number;
      heading?: string;
      excerpt: string;
      vector: number[];
    }>,
  ): void {
    const internal = index as unknown as {
      data: {
        version: number;
        dimensions: number;
        entries: Record<string, unknown>;
      };
    };
    for (const e of entries) {
      const ci = e.chunkIndex ?? 0;
      internal.data.entries[`${e.absPath}#${ci}`] = {
        relPath: path.basename(e.absPath),
        sourceDir: path.dirname(e.absPath),
        mtime: 1,
        vector: e.vector,
        excerpt: e.excerpt,
        heading: e.heading ?? "",
        chunkIndex: ci,
      };
    }
  }

  it("backfills FTS on load from existing entries", async () => {
    const embedder = new TableEmbedder({});
    const idx = new KnowledgeIndex(makeConfig(tmpDir), embedder);

    // Save an index.json directly so load() has something to read
    const data = {
      version: 3,
      dimensions: 4,
      entries: {
        "/v/a.md#0": {
          relPath: "a.md",
          sourceDir: "/v",
          mtime: 1,
          vector: [1, 0, 0, 0],
          excerpt: "authentication middleware",
          heading: "Auth",
          chunkIndex: 0,
        },
      },
    };
    fs.writeFileSync(path.join(tmpDir, "index.json"), JSON.stringify(data));

    await idx.load();
    // FTS side-car should have been backfilled
    const fts = (idx as unknown as { fts: FtsChunkIndex }).fts;
    assert.equal(fts.count(), 1);
    assert.equal(fts.search("authentication", 10).length, 1);
    await idx.close();
  });

  it("RRF fuses vector + BM25 so keyword-only matches still surface", async () => {
    // doc A: strong vector match to the query, weak keyword match
    // doc B: weak vector match, exact keyword hit
    // Both should appear in the top results.
    const queryVec = [1, 0, 0, 0];
    const embedder = new TableEmbedder({ "deploy rollout": queryVec });
    const idx = new KnowledgeIndex(makeConfig(tmpDir), embedder);
    await idx.load();

    seed(idx, [
      {
        absPath: "/v/semantic-close.md",
        vector: [0.9, 0.4, 0, 0], // strong cosine with queryVec
        excerpt: "releasing features to production gradually",
      },
      {
        absPath: "/v/keyword-hit.md",
        vector: [0.2, 0.2, 0.9, 0], // weak cosine
        excerpt: "deploy rollout playbook for weekly releases",
      },
      {
        absPath: "/v/noise.md",
        vector: [0, 0, 0, 1], // orthogonal
        excerpt: "completely unrelated content about cooking",
      },
    ]);

    // Backfill FTS explicitly since we seeded via the private handle
    (idx as unknown as { rebuildFtsFromEntries: () => void }).rebuildFtsFromEntries();

    const results = await idx.hybridSearch("deploy rollout", 5);
    const paths = results.map((r) => r.path);
    assert.ok(paths.includes("/v/keyword-hit.md"), "keyword hit must appear");
    assert.ok(paths.includes("/v/semantic-close.md"), "semantic hit must appear");
    assert.ok(!paths.includes("/v/noise.md"), "noise should be filtered");
    await idx.close();
  });

  it("falls back to pure BM25 when embedder fails", async () => {
    const embedder = new TableEmbedder({}); // empty table → embed() throws
    const idx = new KnowledgeIndex(makeConfig(tmpDir), embedder);
    await idx.load();

    seed(idx, [
      {
        absPath: "/v/hit.md",
        vector: [1, 0, 0, 0],
        excerpt: "quarterly planning retrospective notes",
      },
    ]);
    (idx as unknown as { rebuildFtsFromEntries: () => void }).rebuildFtsFromEntries();

    const results = await idx.hybridSearch("quarterly planning", 5);
    assert.equal(results.length, 1);
    assert.equal(results[0].path, "/v/hit.md");
    await idx.close();
  });

  it("falls back to pure vector when FTS side-car is empty", async () => {
    const queryVec = [1, 0, 0, 0];
    const embedder = new TableEmbedder({ cats: queryVec });
    const idx = new KnowledgeIndex(makeConfig(tmpDir), embedder);
    await idx.load();

    seed(idx, [
      {
        absPath: "/v/cats.md",
        vector: [0.95, 0.1, 0, 0],
        excerpt: "feline antics",
      },
    ]);
    // Intentionally DO NOT backfill FTS
    const results = await idx.hybridSearch("cats", 5);
    assert.equal(results.length, 1);
    assert.equal(results[0].path, "/v/cats.md");
    await idx.close();
  });

  it("deduplicates to best chunk per file", async () => {
    const queryVec = [1, 0, 0, 0];
    const embedder = new TableEmbedder({ widgets: queryVec });
    const idx = new KnowledgeIndex(makeConfig(tmpDir), embedder);
    await idx.load();

    seed(idx, [
      {
        absPath: "/v/doc.md",
        chunkIndex: 0,
        vector: [0.9, 0.1, 0, 0],
        excerpt: "widgets introduction",
      },
      {
        absPath: "/v/doc.md",
        chunkIndex: 1,
        vector: [0.8, 0.1, 0, 0],
        excerpt: "widgets advanced usage",
      },
      {
        absPath: "/v/doc.md",
        chunkIndex: 2,
        vector: [0.7, 0.1, 0, 0],
        excerpt: "widgets conclusion",
      },
    ]);
    (idx as unknown as { rebuildFtsFromEntries: () => void }).rebuildFtsFromEntries();

    const results = await idx.hybridSearch("widgets", 5);
    assert.equal(results.length, 1, "should only return one hit per file");
    assert.equal(results[0].path, "/v/doc.md");
    await idx.close();
  });
});

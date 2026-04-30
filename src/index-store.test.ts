import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { KnowledgeIndex, dotProduct } from "./index-store.js";
import type { Config } from "./config.js";
import type { Embedder } from "./embedder.js";

describe("dotProduct", () => {
  it("returns 0 for orthogonal vectors", () => {
    assert.equal(dotProduct([1, 0, 0], [0, 1, 0]), 0);
  });

  it("returns 1 for identical unit vectors", () => {
    const v = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)];
    const result = dotProduct(v, v);
    assert.ok(Math.abs(result - 1.0) < 1e-10, `Expected ~1.0, got ${result}`);
  });

  it("returns -1 for opposite unit vectors", () => {
    const v1 = [1, 0, 0];
    const v2 = [-1, 0, 0];
    assert.equal(dotProduct(v1, v2), -1);
  });

  it("computes correct dot product", () => {
    assert.equal(dotProduct([1, 2, 3], [4, 5, 6]), 32); // 4+10+18
  });

  it("handles empty vectors", () => {
    assert.equal(dotProduct([], []), 0);
  });

  it("handles mismatched lengths (uses shorter)", () => {
    assert.equal(dotProduct([1, 2], [3, 4, 5]), 11); // 3+8
  });

  it("works with high-dimensional vectors", () => {
    const dim = 512;
    const a = new Array(dim).fill(1 / Math.sqrt(dim));
    const b = new Array(dim).fill(1 / Math.sqrt(dim));
    const result = dotProduct(a, b);
    assert.ok(
      Math.abs(result - 1.0) < 1e-10,
      `Expected ~1.0 for normalized vectors, got ${result}`
    );
  });
});

// ---------------------------------------------------------------------------
// Streaming load/save round-trip
//
// These tests exercise the streaming JSON reader (stream-json based) and the
// manual streaming JSON writer used to persist the index. The streaming paths
// exist so that very large indexes (>500MB of serialised state) don't trip
// V8's "Invalid string length" limit that `readFileSync` + `JSON.parse` and
// `JSON.stringify` + `writeFileSync` would hit.
// ---------------------------------------------------------------------------

class StubEmbedder implements Embedder {
  async embed(): Promise<number[]> {
    throw new Error("not used in these tests");
  }
  async embedBatch(): Promise<(number[] | null)[]> {
    throw new Error("not used in these tests");
  }
}

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

describe("KnowledgeIndex streaming load/save", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ks-index-store-"));
  });

  beforeEach(() => {
    for (const f of fs.readdirSync(tmpDir)) {
      fs.rmSync(path.join(tmpDir, f), { force: true });
    }
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seed(index: KnowledgeIndex, count: number, dims = 4): void {
    const internal = index as unknown as {
      data: {
        version: number;
        dimensions: number;
        entries: Record<string, unknown>;
      };
    };
    for (let i = 0; i < count; i++) {
      internal.data.entries[`/vault/file-${i}.md#0`] = {
        relPath: `file-${i}.md`,
        sourceDir: "/vault",
        mtime: 1_700_000_000_000 + i,
        vector: Array.from({ length: dims }, (_, k) => Math.sin(i + k)),
        excerpt: `Excerpt for file ${i}. It contains UTF-8 content including \u00e9\u00e1\u00f1 and emoji \ud83d\udcdd and newlines\nacross\nlines.`,
        heading: i % 3 === 0 ? "intro" : `Section ${i}`,
        chunkIndex: 0,
      };
    }
  }

  it("save + load round-trips entries unchanged", async () => {
    const config = makeConfig(tmpDir);
    const writer = new KnowledgeIndex(config, new StubEmbedder());
    seed(writer, 42);

    const saveMethod = (writer as unknown as { save: () => Promise<void> }).save;
    await saveMethod.call(writer);

    const reader = new KnowledgeIndex(config, new StubEmbedder());
    await reader.load();

    const writerData = (writer as unknown as { data: { entries: Record<string, unknown> } }).data;
    const readerData = (reader as unknown as { data: { entries: Record<string, unknown> } }).data;

    assert.equal(reader.chunkCount(), writer.chunkCount());
    assert.deepStrictEqual(readerData, writerData);
  });

  it("load returns an empty index when no file exists", async () => {
    const config = makeConfig(tmpDir);
    const reader = new KnowledgeIndex(config, new StubEmbedder());
    await reader.load();
    assert.equal(reader.chunkCount(), 0);
  });

  it("load discards a corrupt index file instead of throwing", async () => {
    const config = makeConfig(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "index.json"), "{ this is not json !!");
    const reader = new KnowledgeIndex(config, new StubEmbedder());
    await reader.load();
    assert.equal(reader.chunkCount(), 0);
  });

  it("load discards an index with a mismatched version", async () => {
    const config = makeConfig(tmpDir);
    fs.writeFileSync(
      path.join(tmpDir, "index.json"),
      JSON.stringify({ version: 1, dimensions: 4, entries: { "a#0": { vector: [1, 0, 0, 0] } } })
    );
    const reader = new KnowledgeIndex(config, new StubEmbedder());
    await reader.load();
    assert.equal(reader.chunkCount(), 0);
  });

  it("load discards an index with mismatched dimensions (triggers re-index)", async () => {
    const config = makeConfig(tmpDir, 4);
    fs.writeFileSync(
      path.join(tmpDir, "index.json"),
      JSON.stringify({
        version: 3,
        dimensions: 1024,
        entries: { "a#0": { vector: new Array(1024).fill(0) } },
      })
    );
    const reader = new KnowledgeIndex(config, new StubEmbedder());
    await reader.load();
    assert.equal(reader.chunkCount(), 0);
  });

  it("save writes atomically via a .tmp file + rename", async () => {
    const config = makeConfig(tmpDir);
    const writer = new KnowledgeIndex(config, new StubEmbedder());
    seed(writer, 5);

    const saveMethod = (writer as unknown as { save: () => Promise<void> }).save;
    await saveMethod.call(writer);

    // After save, the .tmp file must not linger
    assert.ok(fs.existsSync(path.join(tmpDir, "index.json")));
    assert.ok(!fs.existsSync(path.join(tmpDir, "index.json.tmp")));
  });

  it("round-trips many entries without materialising a single giant string", async () => {
    // This test is about the streaming path — it doesn't verify memory use
    // directly (hard to do in pure node:test) but it does confirm the writer
    // can emit a sizeable index (~5MB of vectors) and the reader can restore
    // it byte-for-byte. With the old readFileSync/writeFileSync path this
    // would still work; the real benefit of streaming kicks in above ~500MB,
    // which is impractical to allocate in CI. So this is a smoke test that
    // the streaming code path behaves correctly on non-trivial input.
    const config = makeConfig(tmpDir, 256);
    const writer = new KnowledgeIndex(config, new StubEmbedder());
    seed(writer, 500, 256); // 500 entries x 256 dims ≈ a few MB serialised

    const saveMethod = (writer as unknown as { save: () => Promise<void> }).save;
    await saveMethod.call(writer);

    const reader = new KnowledgeIndex(config, new StubEmbedder());
    await reader.load();

    assert.equal(reader.chunkCount(), 500);
    const writerData = (writer as unknown as { data: { entries: Record<string, unknown> } }).data;
    const readerData = (reader as unknown as { data: { entries: Record<string, unknown> } }).data;
    assert.deepStrictEqual(readerData, writerData);
  });

  it("falls back to streaming writer when JSON.stringify would exceed V8's string limit", async () => {
    // Force the streaming fallback by monkey-patching JSON.stringify to throw
    // RangeError the way V8 does on strings >= 2^29 bytes. The writer should
    // catch that specific error and re-emit via createWriteStream instead.
    const config = makeConfig(tmpDir);
    const writer = new KnowledgeIndex(config, new StubEmbedder());
    seed(writer, 30);

    const realStringify = JSON.stringify;
    let fastPathCalled = false;
    let streamingPathWorked = false;
    // Only throw on the *first* top-level stringify of the whole data object.
    // The streaming path still uses JSON.stringify for individual keys/values
    // which must keep working.
    (JSON as unknown as { stringify: (v: unknown, ...rest: unknown[]) => string }).stringify = (
      value: unknown,
      ...rest: unknown[]
    ): string => {
      if (!fastPathCalled && value && typeof value === "object" && "version" in value && "entries" in value) {
        fastPathCalled = true;
        throw new RangeError("Invalid string length");
      }
      return realStringify(value, ...(rest as [any, any]));
    };

    try {
      const saveMethod = (writer as unknown as { save: () => Promise<void> }).save;
      await saveMethod.call(writer);
      streamingPathWorked = true;
    } finally {
      (JSON as unknown as { stringify: typeof realStringify }).stringify = realStringify;
    }

    assert.ok(fastPathCalled, "expected fast path to be attempted first");
    assert.ok(streamingPathWorked, "expected streaming fallback to complete");

    // Confirm the written file parses correctly with the regular loader.
    const reader = new KnowledgeIndex(config, new StubEmbedder());
    await reader.load();
    assert.equal(reader.chunkCount(), 30);
  });
});

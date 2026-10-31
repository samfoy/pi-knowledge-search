import { describe, it, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { KnowledgeIndex } from "./index-store.js";
import extension from "./index.js";

// Exercises the extension entry point end to end against the real sync
// worker (dist/sync-worker.mjs), in FTS-only mode so no embedder is needed.
// The assertions count KnowledgeIndex.load() calls in the pi process: each
// one is a full parse of index.json, which is the dominant per-session cost
// for large vaults.

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;
type Tool = { execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> };

describe("extension index lifecycle", () => {
  let tmp: string;
  let savedEnv: NodeJS.ProcessEnv;
  let workers: ChildProcess[];
  let loadCalls: ReturnType<typeof mock.method>;

  before(() => {
    const realFork = childProcess.fork;
    mock.method(childProcess, "fork", (...args: Parameters<typeof realFork>) => {
      const child = realFork(...args);
      workers.push(child);
      return child;
    });
    syncBuiltinESMExports();
  });

  after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ks-lifecycle-"));
    const vault = path.join(tmp, "vault");
    fs.mkdirSync(vault);
    fs.writeFileSync(
      path.join(vault, "note.md"),
      "# Zebra migration\n\nThe zebra herd migrates north every spring.\n"
    );
    savedEnv = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("KNOWLEDGE_SEARCH_") || key === "OPENAI_API_KEY") delete process.env[key];
    }
    process.env.HOME = tmp;
    workers = [];
    loadCalls = mock.method(KnowledgeIndex.prototype, "load");
  });

  afterEach(() => {
    loadCalls.mock.restore();
    process.env = savedEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeConfig(inject: boolean): void {
    fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".pi", "knowledge-search.json"),
      JSON.stringify({ dirs: [path.join(tmp, "vault")], overview: { inject } })
    );
  }

  async function startSession() {
    const handlers = new Map<string, Handler[]>();
    const tools = new Map<string, Tool>();
    const pi = {
      on: (name: string, handler: Handler) =>
        handlers.set(name, [...(handlers.get(name) ?? []), handler]),
      registerCommand: () => {},
      registerTool: (tool: Tool & { name: string }) => tools.set(tool.name, tool),
      sendMessage: () => {},
    };
    const ctx = {
      cwd: tmp,
      hasUI: true,
      ui: { notify: () => {}, setStatus: () => {} },
      sessionManager: { getEntries: () => [] },
    };
    extension(pi as never);
    for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
    return {
      search: (query: string) => tools.get("knowledge_search")!.execute("id", { query }),
      shutdown: async () => {
        for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
      },
    };
  }

  /** Wait for every forked worker to exit and the extension's exit handler to run. */
  async function workersDone(): Promise<void> {
    await Promise.all(
      workers.map((w) => (w.exitCode !== null ? undefined : new Promise((r) => w.once("exit", r))))
    );
    await new Promise((r) => setTimeout(r, 50));
  }

  it("does not load the index until the first search when overview injection is off", async () => {
    writeConfig(false);
    const session = await startSession();
    await workersDone();
    assert.equal(loadCalls.mock.callCount(), 0, "no load at session start or after sync");

    const result = await session.search("zebra");
    assert.match(result.content[0].text, /note\.md/);
    assert.equal(loadCalls.mock.callCount(), 1);

    await session.search("zebra");
    assert.equal(loadCalls.mock.callCount(), 1, "second search reuses the loaded index");
    await session.shutdown();
  });

  it("re-reads a loaded index on next use when the worker changed it", async () => {
    writeConfig(true);
    const session = await startSession();
    assert.equal(loadCalls.mock.callCount(), 1, "overview injection loads eagerly");
    await workersDone();
    assert.equal(loadCalls.mock.callCount(), 1, "the sync only marks the index stale");

    const result = await session.search("zebra");
    assert.match(result.content[0].text, /note\.md/);
    assert.equal(loadCalls.mock.callCount(), 2, "worker added a file, so the next search reloads");
    await session.shutdown();
  });

  it("does not reload the index when the worker found no changes", async () => {
    writeConfig(true);
    const first = await startSession();
    await workersDone();
    await first.shutdown();
    loadCalls.mock.resetCalls();
    workers = [];

    const second = await startSession();
    await workersDone();
    assert.equal(workers.length, 1);
    assert.equal(loadCalls.mock.callCount(), 1, "only the eager load");

    await second.search("zebra");
    assert.equal(loadCalls.mock.callCount(), 1, "a no-op sync leaves the index fresh; no reload");
    await second.shutdown();
  });
});

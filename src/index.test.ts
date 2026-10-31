import { describe, it, before, after } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "./index.js";

// Regression: the done message must not crash the host when the session ctx is already stale.

const envKeys = [
  "KNOWLEDGE_SEARCH_DIRS",
  "KNOWLEDGE_SEARCH_INDEX_DIR",
  "KNOWLEDGE_SEARCH_CWD",
  "KNOWLEDGE_SEARCH_CONFIG",
  "KNOWLEDGE_SEARCH_PROVIDER",
  "KNOWLEDGE_SEARCH_OPENAI_API_KEY",
  "KNOWLEDGE_SEARCH_EXTENSIONS",
  "OPENAI_API_KEY",
  "HOME",
];

const originalEnv: Record<string, string | undefined> = {};
let notesDir: string;
let indexDir: string;
let homeDir: string;

async function waitUntil(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Fake pi: capture the lifecycle handlers, swallow the registrations. */
function makePi() {
  const handlers: {
    session_start?: (event: unknown, ctx: unknown) => Promise<void>;
    session_shutdown?: () => Promise<void>;
  } = {};
  const pi = {
    on: (event: string, handler: (event?: unknown, ctx?: unknown) => unknown) => {
      if (event === "session_start") {
        handlers.session_start = handler as NonNullable<typeof handlers.session_start>;
      } else if (event === "session_shutdown") {
        handlers.session_shutdown = handler as NonNullable<typeof handlers.session_shutdown>;
      }
    },
    registerCommand: () => {},
    registerTool: () => {},
  };
  return { handlers, pi };
}

/** A session ctx that is already stale: any ui access throws. */
function staleCtx(cwd: string) {
  return {
    cwd,
    get ui(): never {
      throw new Error("stale session ctx");
    },
  };
}

describe("extension stale-ctx completion path", () => {
  before(() => {
    for (const key of envKeys) originalEnv[key] = process.env[key];
    notesDir = fs.mkdtempSync(path.join(os.tmpdir(), "ks-host-notes-"));
    indexDir = fs.mkdtempSync(path.join(os.tmpdir(), "ks-host-index-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ks-host-home-"));
    // FTS-only temp env: two notes, no provider, no user overrides.
    delete process.env.KNOWLEDGE_SEARCH_CWD;
    delete process.env.KNOWLEDGE_SEARCH_CONFIG;
    delete process.env.KNOWLEDGE_SEARCH_PROVIDER;
    delete process.env.KNOWLEDGE_SEARCH_OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.KNOWLEDGE_SEARCH_EXTENSIONS;
    process.env.KNOWLEDGE_SEARCH_DIRS = notesDir;
    process.env.KNOWLEDGE_SEARCH_INDEX_DIR = indexDir;
    process.env.HOME = homeDir;
    fs.writeFileSync(
      path.join(notesDir, "alpha.md"),
      "# alpha\n\nA sufficiently long body about apples and orchards to be indexed.\n"
    );
    fs.writeFileSync(
      path.join(notesDir, "beta.md"),
      "# beta\n\nA sufficiently long body about rockets and orbits to be indexed.\n"
    );
  });

  after(() => {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key]!;
    }
    fs.rmSync(notesDir, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("does not crash when the sync worker reports done into a stale ctx", async () => {
    const { handlers, pi } = makePi();
    extension(pi as unknown as Parameters<typeof extension>[0]);

    await handlers.session_start!(undefined, staleCtx(homeDir));

    // The worker persists the index before posting done — wait for it, then
    // give the done message (posted microseconds after the write) time to
    // reach the host's message handler.
    const indexFile = path.join(indexDir, "index.json");
    await waitUntil(() => fs.existsSync(indexFile), 30_000);
    await new Promise((r) => setTimeout(r, 250));

    // Pre-fix, the done handler's ctx.ui access threw an uncaught exception here, failing the test.
    await handlers.session_shutdown!();
  });
});

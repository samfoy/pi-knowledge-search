import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { Worker } from "node:worker_threads";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Exercises the committed dist/sync-worker.mjs through a real Worker (#17).
const workerFile = fileURLToPath(new URL("../dist/sync-worker.mjs", import.meta.url));

let notesDir: string;
let indexDir: string;
let homeDir: string;
let baseEnv: NodeJS.ProcessEnv;

function writeNote(name: string, body: string) {
  fs.writeFileSync(path.join(notesDir, name), `# ${name}\n\n${body}\n`);
}

type WorkerOutcome = {
  result: ({ type: string } & Record<string, number>) | null;
  error: Error | null;
  exitCode: number | null;
};

/** Run one sync through a real worker thread and collect its lifecycle events. */
function runSyncWorker(env: NodeJS.ProcessEnv, cwd?: string): Promise<WorkerOutcome> {
  const worker = new Worker(workerFile, {
    workerData: { cwd: cwd ?? homeDir },
    stdout: true,
    stderr: true,
    env,
  });
  return new Promise<WorkerOutcome>((resolve, reject) => {
    const outcome: WorkerOutcome = { result: null, error: null, exitCode: null };
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new Error("sync worker did not finish within 30s"));
    }, 30_000);
    worker.on("message", (msg: unknown) => {
      outcome.result = msg as { type: string } & Record<string, number>;
    });
    worker.on("error", (err: Error) => {
      outcome.error = err;
    });
    worker.on("exit", (code) => {
      clearTimeout(timeout);
      outcome.exitCode = code;
      resolve(outcome);
    });
  });
}

describe("sync-worker (worker_threads mode)", () => {
  before(() => {
    notesDir = fs.mkdtempSync(path.join(os.tmpdir(), "ks-worker-notes-"));
    indexDir = fs.mkdtempSync(path.join(os.tmpdir(), "ks-worker-index-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ks-worker-home-"));
    baseEnv = {
      HOME: homeDir,
      KNOWLEDGE_SEARCH_DIRS: notesDir,
      KNOWLEDGE_SEARCH_INDEX_DIR: indexDir,
    };
    writeNote("alpha.md", "A sufficiently long body about apples and orchards to be indexed.");
    writeNote("beta.md", "A sufficiently long body about rockets and orbits to be indexed.");
  });

  after(() => {
    fs.rmSync(notesDir, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("reports the sync result over parentPort and persists the index", async () => {
    const { result, error, exitCode } = await runSyncWorker(baseEnv);
    assert.equal(error, null);
    assert.equal(exitCode, 0);
    assert.ok(result, "expected a result message from the worker");
    assert.equal(result.type, "done");
    assert.equal(result.added, 2);
    assert.equal(result.updated, 0);
    assert.equal(result.removed, 0);
    assert.equal(result.size, 2);
    assert.ok(result.chunks >= 2);
    // index persisted by exit
    assert.ok(fs.existsSync(path.join(indexDir, "index.json")), "index.json written");
  });

  it("reports a no-op second run (loads the existing index)", async () => {
    const { result, error } = await runSyncWorker(baseEnv);
    assert.equal(error, null);
    assert.ok(result, "expected a result message from the worker");
    assert.equal(result.type, "done");
    assert.equal(result.added, 0);
    assert.equal(result.updated, 0);
    assert.equal(result.removed, 0);
    assert.equal(result.size, 2);
  });

  it("propagates failures as a worker error and non-zero exit (drives restarts)", async () => {
    // Index dir under a regular file → the FtsChunkIndex constructor's
    // mkdirSync fails → the rejection must surface as the Worker 'error'
    // event with a non-zero exit, which is what spawnWorker's restart loop
    // keys off.
    const blocker = path.join(homeDir, "blocker");
    fs.writeFileSync(blocker, "not a directory");
    const { result, error, exitCode } = await runSyncWorker({
      ...baseEnv,
      KNOWLEDGE_SEARCH_INDEX_DIR: path.join(blocker, "index"),
    });
    assert.equal(result, null, "no result on failure");
    assert.ok(error, "expected a worker error event");
    assert.match(error.message, /ENOTDIR/);
    assert.notEqual(exitCode, 0);
  });

  it("forwards workerData.cwd to resolve the project-local settings.json", async () => {
    // A worker that ignored workerData.cwd would never see <projectDir>/.pi/
    // settings.json and would index into the global dir instead of the
    // project-local base (issue #17's worker contract).
    const projectDir = path.join(homeDir, "proj");
    const base = path.join(projectDir, "custom-idx");
    fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
    // Absolute localPath — resolveLocalBase returns it verbatim; a relative
    // one would resolve against this test process's cwd, not projectDir.
    fs.writeFileSync(
      path.join(projectDir, ".pi", "settings.json"),
      JSON.stringify({ "pi-knowledge-search": { localPath: base } })
    );

    const env = { ...baseEnv };
    delete env.KNOWLEDGE_SEARCH_INDEX_DIR; // the project-local index dir must win
    const { result, error } = await runSyncWorker(env, projectDir);
    assert.equal(error, null);
    assert.ok(result, "expected a result message from the worker");
    assert.equal(result.type, "done");
    assert.ok(
      fs.existsSync(path.join(projectDir, "custom-idx", "index", "index.json")),
      "index written under the project-local base"
    );
  });

  it("standalone run (manual-recovery path) prints a JSON summary and exits 0", () => {
    // `node dist/sync-worker.mjs` is the issue-#17 manual-recovery step — pin
    // its stdout JSON contract and exit code in CI.
    const standaloneIndex = path.join(homeDir, "standalone-index");
    const res = spawnSync(process.execPath, [workerFile], {
      env: { ...baseEnv, KNOWLEDGE_SEARCH_INDEX_DIR: standaloneIndex },
      timeout: 30_000,
    });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const summary = JSON.parse(res.stdout.toString());
    assert.equal(summary.added, 2);
    assert.equal(summary.size, 2);
  });

  it("standalone run exits non-zero when the index dir is unwritable", () => {
    // A regular file where the index dir should be → FtsChunkIndex's
    // mkdirSync throws → the run reports the error and exits non-zero.
    const blocker = path.join(homeDir, "standalone-blocker");
    fs.writeFileSync(blocker, "not a directory");
    const res = spawnSync(process.execPath, [workerFile], {
      env: { ...baseEnv, KNOWLEDGE_SEARCH_INDEX_DIR: path.join(blocker, "index") },
      timeout: 30_000,
    });
    assert.equal(res.status, 1, `stderr: ${res.stderr}`);
    assert.match(String(res.stderr), /ENOTDIR/);
  });
});

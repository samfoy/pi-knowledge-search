#!/usr/bin/env node
import { parentPort, workerData } from "node:worker_threads";
import { loadConfig } from "./config.js";
import { createEmbedder } from "./embedder.js";
import { KnowledgeIndex } from "./index-store.js";

// Runs as a worker_threads Worker (result via parentPort) or standalone (`node dist/sync-worker.mjs`:
// stdout JSON + exit code). Never call process.exit() in worker mode — the result would be lost (#17).
const port = parentPort;

async function run() {
  const cwd = port
    ? (workerData as { cwd?: string } | undefined)?.cwd
    : process.env.KNOWLEDGE_SEARCH_CWD || undefined;
  const config = loadConfig(cwd);
  if (!config || config.dirs.length === 0) return null;

  const embedder = config.provider ? createEmbedder(config.provider, config.dimensions) : null;
  const index = new KnowledgeIndex(config, embedder);
  await index.load();
  const { added, updated, removed } = await index.sync();
  return { added, updated, removed, size: index.size(), chunks: index.chunkCount() };
}

if (port) {
  // Worker mode: a rejection surfaces as the host's 'error' event + non-zero exit (drives restarts).
  run().then((result) => {
    if (result) port.postMessage({ type: "done", ...result });
  });
} else {
  // Report uncaught errors back to parent before exiting
  process.on("uncaughtException", (err) => {
    process.stderr.write(`knowledge-search worker uncaught: ${err.message}\n`);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`knowledge-search worker unhandled rejection: ${reason}\n`);
    process.exit(1);
  });

  run()
    .then((result) => {
      if (result) process.stdout.write(JSON.stringify(result));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(err.message);
      process.exit(1);
    });
}

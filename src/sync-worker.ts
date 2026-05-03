#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { createEmbedder } from "./embedder.js";
import { KnowledgeIndex } from "./index-store.js";

// Report uncaught errors back to parent before exiting
process.on("uncaughtException", (err) => {
  process.stderr.write(`knowledge-search worker uncaught: ${err.message}\n`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`knowledge-search worker unhandled rejection: ${reason}\n`);
  process.exit(1);
});

const config = loadConfig(process.env.KNOWLEDGE_SEARCH_CWD || undefined);
if (!config || config.dirs.length === 0) {
  process.exit(0);
}

const embedder = config.provider
  ? createEmbedder(config.provider, config.dimensions)
  : null;
const index = new KnowledgeIndex(config, embedder);
await index.load();

index
  .sync()
  .then(({ added, updated, removed }) => {
    const result = JSON.stringify({
      added,
      updated,
      removed,
      size: index.size(),
      chunks: index.chunkCount(),
    });
    process.stdout.write(result);
    process.exit(0);
  })
  .catch((err) => {
    process.stderr.write(err.message);
    process.exit(1);
  });

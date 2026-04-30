#!/usr/bin/env node
import { loadConfig } from "./config";
import { createEmbedder } from "./embedder";
import { KnowledgeIndex } from "./index-store";

// Report uncaught errors back to parent before exiting
process.on("uncaughtException", (err) => {
  process.stderr.write(`knowledge-search worker uncaught: ${err.message}\n`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`knowledge-search worker unhandled rejection: ${reason}\n`);
  process.exit(1);
});

const config = loadConfig();
if (!config) {
  process.exit(0);
}

const embedder = createEmbedder(config.provider, config.dimensions);
const index = new KnowledgeIndex(config, embedder);
index.loadSync();

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

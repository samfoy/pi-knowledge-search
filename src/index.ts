import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { fork } from "node:child_process";
import { join } from "node:path";
import {
  loadConfig,
  saveConfig,
  getConfigPath,
  type Config,
  type ConfigFile,
} from "./config";
import { createEmbedder } from "./embedder";
import { KnowledgeIndex } from "./index-store";
import { FileWatcher } from "./watcher";

export default function (pi: ExtensionAPI) {
  let index: KnowledgeIndex | null = null;
  let watcher: FileWatcher | null = null;
  let currentConfig: Config | null = null;
  let syncDone = false;
  let workerExitExpected = false;

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  pi.on("session_start", (_event, ctx) => {
    try {
      currentConfig = loadConfig();
    } catch {
      return;
    }
    if (!currentConfig) return;

    const embedder = createEmbedder(currentConfig.provider, currentConfig.dimensions);
    index = new KnowledgeIndex(currentConfig, embedder);
    index.loadSync();

    // Sync in a child process so it never blocks the main event loop
    function spawnWorker() {
      const worker = fork(
        join(import.meta.dirname, "sync-worker.ts"),
        [],
        {
          execArgv: ["--import", "tsx/esm"],
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          env: { ...process.env },
        }
      );

      let stdout = "";
      worker.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      worker.stderr?.on("data", (chunk: Buffer) => {
        console.error(`knowledge-search worker: ${chunk.toString().trim()}`);
      });

      worker.on("error", (err) => {
        console.error(`knowledge-search: worker error: ${err.message}`);
      });

      worker.on("exit", (code, signal) => {
        syncDone = true;
        if (code === 0 && stdout) {
          try {
            const result = JSON.parse(stdout);
            // Reload the index from disk since the worker updated it
            index!.loadSync();
            const changes = result.added + result.updated + result.removed;
            if (changes > 0) {
              ctx.ui.setStatus(
                "knowledge-search",
                `Index: +${result.added} ~${result.updated} -${result.removed} (${result.size} files)`
              );
              setTimeout(() => ctx.ui.setStatus("knowledge-search", ""), 5000);
            }
          } catch {
            // ignore parse errors
          }
        } else if (code !== 0 && !workerExitExpected) {
          // Unexpected exit — restart once
          console.error(
            `knowledge-search: worker exited unexpectedly (code=${code}, signal=${signal}), restarting...`
          );
          setTimeout(() => {
            if (!workerExitExpected) spawnWorker();
          }, 2000);
        }
      });
      worker.unref();
    }

    spawnWorker();
  });

  pi.on("session_shutdown", async () => {
    workerExitExpected = true;
    watcher?.stop();
    index?.close();
  });

  // ------------------------------------------------------------------
  // Setup command
  // ------------------------------------------------------------------

  pi.registerCommand("knowledge-search-setup", {
    description: "Configure knowledge search directories and embedding provider",
    handler: async (_args, ctx) => {
      // Step 1: Directories
      const dirsInput = await ctx.ui.input(
        "Directories to index (comma-separated):",
        "~/notes, ~/docs"
      );
      if (!dirsInput) {
        ctx.ui.notify("Setup cancelled.", "info");
        return;
      }

      const dirs = dirsInput
        .split(",")
        .map((d: string) => d.trim())
        .filter(Boolean);

      if (dirs.length === 0) {
        ctx.ui.notify("No directories specified.", "warning");
        return;
      }

      // Step 2: File extensions
      const extsInput = await ctx.ui.input(
        "File extensions to index:",
        ".md, .txt"
      );
      const fileExtensions = (extsInput || ".md, .txt")
        .split(",")
        .map((e: string) => e.trim())
        .filter(Boolean);

      // Step 3: Exclude directories
      const excludeInput = await ctx.ui.input(
        "Directory names to exclude:",
        "node_modules, .git, .obsidian, .trash"
      );
      const excludeDirs = (
        excludeInput || "node_modules, .git, .obsidian, .trash"
      )
        .split(",")
        .map((d: string) => d.trim())
        .filter(Boolean);

      // Step 4: Provider
      const providerChoice = await ctx.ui.select("Embedding provider:", [
        "openai — OpenAI API (text-embedding-3-small)",
        "bedrock — AWS Bedrock (Titan Embeddings v2)",
        "ollama — Local Ollama (nomic-embed-text)",
      ]);

      if (!providerChoice) {
        ctx.ui.notify("Setup cancelled.", "info");
        return;
      }

      const providerType = providerChoice.split(" ")[0] as
        | "openai"
        | "bedrock"
        | "ollama";

      let configFile: ConfigFile;

      switch (providerType) {
        case "openai": {
          const apiKey = await ctx.ui.input(
            "OpenAI API key (or env var name):",
            process.env.OPENAI_API_KEY ? "(using OPENAI_API_KEY from env)" : ""
          );
          const model = await ctx.ui.input(
            "Model:",
            "text-embedding-3-small"
          );
          configFile = {
            dirs,
            fileExtensions,
            excludeDirs,
            provider: {
              type: "openai",
              apiKey: apiKey?.startsWith("(") ? undefined : apiKey || undefined,
              model: model || "text-embedding-3-small",
            },
          };
          break;
        }
        case "bedrock": {
          const profile = await ctx.ui.input("AWS profile:", "default");
          const region = await ctx.ui.input("AWS region:", "us-east-1");
          const model = await ctx.ui.input(
            "Model:",
            "amazon.titan-embed-text-v2:0"
          );
          configFile = {
            dirs,
            fileExtensions,
            excludeDirs,
            provider: {
              type: "bedrock",
              profile: profile || "default",
              region: region || "us-east-1",
              model: model || "amazon.titan-embed-text-v2:0",
            },
          };
          break;
        }
        case "ollama": {
          const url = await ctx.ui.input(
            "Ollama URL:",
            "http://localhost:11434"
          );
          const model = await ctx.ui.input("Model:", "nomic-embed-text");
          configFile = {
            dirs,
            fileExtensions,
            excludeDirs,
            provider: {
              type: "ollama",
              url: url || "http://localhost:11434",
              model: model || "nomic-embed-text",
            },
          };
          break;
        }
      }

      // Save and confirm
      saveConfig(configFile!);
      ctx.ui.notify(
        `Config saved to ${getConfigPath()}. Run /reload to activate.`,
        "success"
      );
    },
  });

  // ------------------------------------------------------------------
  // Reindex command
  // ------------------------------------------------------------------

  pi.registerCommand("knowledge-reindex", {
    description: "Force full re-index of all configured knowledge directories",
    handler: async (_args, ctx) => {
      if (!index) {
        ctx.ui.notify(
          "Not configured. Run /knowledge-search-setup first.",
          "warning"
        );
        return;
      }
      ctx.ui.notify("Re-indexing...", "info");
      try {
        await index.rebuild();
        ctx.ui.notify(`Re-indexed: ${index.size()} files`, "success");
      } catch (err: any) {
        ctx.ui.notify(`Re-index failed: ${err.message}`, "error");
      }
    },
  });

  // ------------------------------------------------------------------
  // Search tool
  // ------------------------------------------------------------------

  pi.registerTool({
    name: "knowledge_search",
    label: "Knowledge Search",
    description:
      "Semantic search over local knowledge files. Returns the most relevant file excerpts for a natural language query. Use for finding past notes, investigations, decisions, documentation, and context. Prefer this over grep when you need conceptual or fuzzy matching rather than exact text.",
    promptGuidelines: [
      'Use knowledge_search for conceptual queries (e.g. "how did we handle X", "what was decided about Y"). Use grep/read for exact text or known filenames.',
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Natural language search query" }),
      limit: Type.Optional(
        Type.Number({
          description: "Max results to return (default 8, max 20)",
        })
      ),
    }),
    async execute(toolCallId, params, signal) {
      if (!index || index.size() === 0) {
        const msg = !index
          ? 'knowledge-search is not configured. The user can run /knowledge-search-setup to set it up.'
          : syncDone
            ? "Index is empty."
            : "Index is still syncing in the background. Try again in a moment.";
        return { content: [{ type: "text", text: msg }], details: {} };
      }

      const limit = Math.min(params.limit ?? 8, 20);

      try {
        const results = await index.search(params.query, limit, signal);

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No relevant results found for: "${params.query}"`,
              },
            ],
            details: {},
          };
        }

        const home = process.env.HOME || "";
        const output = results
          .map((r: any, i: number) => {
            const displayPath = r.path.replace(home, "~");
            const score = (r.score * 100).toFixed(1);
            return `### ${i + 1}. ${displayPath} (${score}% match)\n\n${r.excerpt}`;
          })
          .join("\n\n---\n\n");

        const header = `Found ${results.length} results for "${params.query}" (${index.size()} files indexed):\n\n`;

        return {
          content: [{ type: "text", text: header + output }],
          details: { resultCount: results.length, indexSize: index.size() },
        };
      } catch (err: any) {
        throw new Error(`knowledge-search failed: ${err.message}`);
      }
    },
  });
}

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { fork } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { loadConfig, saveConfig, getConfigPath, type Config, type ConfigFile } from "./config.js";
import { createEmbedder } from "./embedder.js";
import { KnowledgeIndex } from "./index-store.js";
import { BedrockKBSearcher } from "./kb-searcher.js";
import { buildOverview, formatOverview } from "./overview.js";
import { resolveNote, readNote } from "./kb-reader.js";

export default function (pi: ExtensionAPI) {
  let index: KnowledgeIndex | null = null;
  let kbSearcher: BedrockKBSearcher | null = null;
  let currentConfig: Config | null = null;
  let sessionCwd: string | undefined;
  let syncDone = false;
  let workerExitExpected = false;

  /**
   * Build and inject the folder+keyword overview as a custom message.
   * @param force When true, inject even if one is already present.
   *              Used by /knowledge-overview after config changes or vault growth.
   * @returns Information about what happened for user-facing feedback.
   */
  function injectOverview(
    ctx: {
      sessionManager: { getEntries: () => SessionEntry[] };
    },
    force: boolean
  ):
    | { status: "skipped"; reason: string }
    | { status: "injected"; totalNotes: number; sourceCount: number } {
    if (!index || !currentConfig) return { status: "skipped", reason: "not configured" };
    if (!force && !currentConfig.overview.inject) {
      return { status: "skipped", reason: "overview.inject=false" };
    }
    if (index.size() === 0) return { status: "skipped", reason: "index is empty" };

    if (!force) {
      const alreadyInjected = ctx.sessionManager
        .getEntries()
        .some(
          (e: SessionEntry) =>
            e.type === "custom_message" && e.customType === "knowledge-overview"
        );
      if (alreadyInjected) return { status: "skipped", reason: "already injected" };
    }

    const overview = buildOverview(index.listFiles(), currentConfig.dirs, {
      maxDepth: currentConfig.overview.maxDepth,
      maxFoldersPerDir: currentConfig.overview.maxFoldersPerDir,
      maxKeywordsPerFolder: currentConfig.overview.maxKeywordsPerFolder,
    });
    const text = formatOverview(overview);
    if (!text) return { status: "skipped", reason: "empty overview" };

    pi.sendMessage({
      customType: "knowledge-overview",
      content: text,
      display: true,
      details: {
        totalNotes: overview.totalNotes,
        sourceCount: overview.sources.length,
        forced: force,
      },
    });
    return {
      status: "injected",
      totalNotes: overview.totalNotes,
      sourceCount: overview.sources.length,
    };
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    sessionCwd = ctx.cwd;
    try {
      currentConfig = loadConfig(sessionCwd);
    } catch {
      return;
    }
    if (!currentConfig) return;

    let indexLoaded: Promise<void> = Promise.resolve();
    if (currentConfig.provider) {
      const embedder = createEmbedder(currentConfig.provider, currentConfig.dimensions);
      index = new KnowledgeIndex(currentConfig, embedder);
      // Fire-and-forget: don't block session_start on the (potentially
      // 99 MB) JSON.parse. injectOverview below awaits this promise; the
      // outbound model HTTP request can fire as soon as session_start
      // returns. See plan: Slice B'.
      indexLoaded = index.load();
    } else if (currentConfig.dirs.length > 0) {
      // FTS-only mode — no embedder, keyword search still works zero-config.
      index = new KnowledgeIndex(currentConfig, null);
      indexLoaded = index.load();
    }

    if (currentConfig.knowledgeBases.length > 0) {
      kbSearcher = new BedrockKBSearcher(currentConfig.knowledgeBases);
    }

    if (!index) {
      syncDone = true;
      return; // KB-only mode — no local index to sync
    }

    // ----------------------------------------------------------------
    // Inject a folder+keyword overview of the vault as a custom message,
    // unless one is already in the session or the user disabled it.
    // Runs off whatever the index has loaded from disk — the worker's
    // incremental sync below will update the store for future sessions.
    //
    // Gated on indexLoaded so the synchronous JSON.parse stays off the
    // session_start critical path; injectOverview itself runs in a
    // microtask after load() resolves, while pi's outbound model HTTP
    // already fired during session_start's earlier return.
    // ----------------------------------------------------------------
    indexLoaded
      .then(() => {
        try {
          injectOverview(ctx, false);
        } catch (err: unknown) {
          // Overview is a nice-to-have — never let it break startup.
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`knowledge-search: overview injection failed: ${msg}`);
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`knowledge-search: index load failed: ${msg}`);
      });

    // Sync in a child process so it never blocks the main event loop
    const MAX_WORKER_RESTARTS = 3;
    const RESTART_WINDOW_MS = 60_000;
    let workerRestartCount = 0;
    let workerRestartWindowStart = Date.now();

    function spawnWorker() {
      // Use pre-compiled worker to avoid ESM/CJS cycle with tsx on Node 25+
      // Rebuild with: npx esbuild src/sync-worker.ts --bundle --platform=node --format=esm --outfile=dist/sync-worker.mjs --external:better-sqlite3 --packages=external
      const workerPath = join(import.meta.dirname, "..", "dist", "sync-worker.mjs");
      const worker = fork(workerPath, [], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        // Suppress "node:sqlite is experimental" warning — node:sqlite is stable
        // enough for our read/write usage and the warning pollutes pi startup.
        execArgv: ["--no-warnings=ExperimentalWarning"],
        // Forward sessionCwd so the worker resolves the same project-local
        // settings.json (pi-knowledge-search.localPath / pi-total-recall cascade).
        env: { ...process.env, KNOWLEDGE_SEARCH_CWD: sessionCwd ?? process.env.KNOWLEDGE_SEARCH_CWD ?? "" },
      });

      let stdout = "";
      let stderrBuf = "";
      // Surface worker status through the managed UI when a TUI is present.
      // Writing directly to the terminal (console.error) from these async
      // callbacks paints outside pi's render region and corrupts the input
      // box; only fall back to console.error in headless (-p/json) modes.
      const report = (msg: string, level: "info" | "warning" | "error" = "error") => {
        if (ctx.hasUI) {
          ctx.ui.notify(msg, level);
        } else {
          console.error(msg);
        }
      };
      worker.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      worker.stderr?.on("data", (chunk: Buffer) => {
        // Buffer worker stderr and surface a single summarized line on exit
        // instead of echoing every chunk raw to the terminal.
        stderrBuf += chunk.toString();
      });

      worker.on("error", (err) => {
        report(`knowledge-search: worker error: ${err.message}`);
      });

      worker.on("exit", async (code, signal) => {
        syncDone = true;
        if (code === 0 && stdout) {
          try {
            const result = JSON.parse(stdout);
            // Reload the index from disk since the worker updated it
            await index!.load();
            const changes = result.added + result.updated + result.removed;
            if (changes > 0) {
              ctx.ui.setStatus(
                "knowledge-search",
                `Index: +${result.added} ~${result.updated} -${result.removed} (${result.size} files, ${result.chunks} chunks)`
              );
              setTimeout(() => ctx.ui.setStatus("knowledge-search", ""), 5000);
            }
          } catch {
            // ignore parse errors
          }
        } else if (code !== 0 && !workerExitExpected) {
          const now = Date.now();
          // Reset counter if outside the time window
          if (now - workerRestartWindowStart > RESTART_WINDOW_MS) {
            workerRestartCount = 0;
            workerRestartWindowStart = now;
          }
          workerRestartCount++;

          const stderrTail = stderrBuf.trim().split("\n").filter(Boolean).pop() ?? "";
          const detail = stderrTail ? ` (${stderrTail})` : "";
          if (workerRestartCount > MAX_WORKER_RESTARTS) {
            report(
              `knowledge-search: indexing worker crashed ${workerRestartCount}x within ${RESTART_WINDOW_MS / 1000}s, giving up${detail}`
            );
          } else {
            report(
              `knowledge-search: indexing worker failed (code=${code}, signal=${signal}), retrying ${workerRestartCount}/${MAX_WORKER_RESTARTS}${detail}`,
              "warning"
            );
            setTimeout(() => {
              if (!workerExitExpected) spawnWorker();
            }, 2000);
          }
        }
        stderrBuf = "";
      });
      worker.unref();
    }

    spawnWorker();
  });

  pi.on("session_shutdown", async () => {
    workerExitExpected = true;
    // watcher removed (d38a81f) — caused UI freezes. Rely on sync-on-startup only.
    await index?.close();
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
      const extsInput = await ctx.ui.input("File extensions to index:", ".md, .txt");
      const fileExtensions = (extsInput || ".md, .txt")
        .split(",")
        .map((e: string) => e.trim())
        .filter(Boolean);

      // Step 3: Exclude directories
      const excludeInput = await ctx.ui.input(
        "Directory names to exclude:",
        "node_modules, .git, .obsidian, .trash"
      );
      const excludeDirs = (excludeInput || "node_modules, .git, .obsidian, .trash")
        .split(",")
        .map((d: string) => d.trim())
        .filter(Boolean);

      // Step 4: Provider
      const providerChoice = await ctx.ui.select("Embedding provider:", [
        "none — FTS-only keyword search (zero-config, no API key needed)",
        "openai — OpenAI API (text-embedding-3-small)",
        "bedrock — AWS Bedrock (Titan Embeddings v2)",
        "ollama — Local Ollama (nomic-embed-text)",
      ]);

      if (!providerChoice) {
        ctx.ui.notify("Setup cancelled.", "info");
        return;
      }

      const providerType = providerChoice.split(" ")[0] as
        | "none"
        | "openai"
        | "bedrock"
        | "ollama";

      let configFile: ConfigFile;

      switch (providerType) {
        case "none": {
          // FTS-only: no provider, keyword search via SQLite FTS5.
          configFile = { dirs, fileExtensions, excludeDirs };
          break;
        }
        case "openai": {
          const apiKey = await ctx.ui.input(
            "OpenAI API key (or env var name):",
            process.env.OPENAI_API_KEY ? "(using OPENAI_API_KEY from env)" : ""
          );
          const model = await ctx.ui.input("Model:", "text-embedding-3-small");
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
          const model = await ctx.ui.input("Model:", "amazon.titan-embed-text-v2:0");
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
          const url = await ctx.ui.input("Ollama URL:", "http://localhost:11434");
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
      saveConfig(configFile!, sessionCwd);
      ctx.ui.notify(`Config saved to ${getConfigPath(sessionCwd)}. Run /reload to activate.`, "info");
    },
  });

  // ------------------------------------------------------------------
  // Add Knowledge Base command
  // ------------------------------------------------------------------

  pi.registerCommand("knowledge-add-kb", {
    description: "Add a Bedrock Knowledge Base as a search source",
    handler: async (_args, ctx) => {
      const kbId = await ctx.ui.input("Bedrock Knowledge Base ID:", "");
      if (!kbId) {
        ctx.ui.notify("Cancelled.", "info");
        return;
      }

      const label = await ctx.ui.input("Label (optional, for display):", "");

      const region = await ctx.ui.input("AWS region:", "us-east-1");

      const profile = await ctx.ui.input("AWS profile:", "default");

      // Load existing config or create minimal one
      let existing: ConfigFile;
      try {
        const loaded = loadConfig(sessionCwd);
        if (loaded) {
          // Read the raw file to preserve structure
          const raw = fs.readFileSync(getConfigPath(sessionCwd), "utf-8");
          existing = JSON.parse(raw);
        } else {
          existing = {};
        }
      } catch {
        existing = {};
      }

      if (!existing.knowledgeBases) existing.knowledgeBases = [];

      // Don't add duplicates
      if (existing.knowledgeBases.some((kb: any) => kb.id === kbId)) {
        ctx.ui.notify(`KB ${kbId} already configured.`, "warning");
        return;
      }

      existing.knowledgeBases.push({
        id: kbId,
        region: region || "us-east-1",
        profile: profile || "default",
        ...(label ? { label } : {}),
      });

      saveConfig(existing as ConfigFile, sessionCwd);
      ctx.ui.notify(
        `Added KB ${kbId}${label ? ` (${label})` : ""}. Run /reload to activate.`,
        "info"
      );
    },
  });

  // ------------------------------------------------------------------
  // Reindex command
  // ------------------------------------------------------------------

  pi.registerCommand("knowledge-overview", {
    description:
      "Rebuild and re-inject the knowledge-search vault overview (use after config changes or vault growth)",
    handler: async (_args, ctx) => {
      try {
        const result = injectOverview(ctx, true);
        if (result.status === "injected") {
          ctx.ui.notify(
            `Overview re-injected: ${result.totalNotes} notes, ${result.sourceCount} source dir(s).`,
            "info"
          );
        } else {
          ctx.ui.notify(`Overview not injected: ${result.reason}.`, "warning");
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Overview injection failed: ${msg}`, "error");
      }
    },
  });

  pi.registerCommand("knowledge-reindex", {
    description: "Force full re-index of all configured knowledge directories",
    handler: async (_args, ctx) => {
      if (!index) {
        ctx.ui.notify("Not configured. Run /knowledge-search-setup first.", "warning");
        return;
      }
      ctx.ui.notify("Re-indexing...", "info");
      try {
        await index.rebuild();
        ctx.ui.notify(
          `Re-indexed: ${index.size()} files (${index.chunkCount()} chunks)`,
          "info"
        );
      } catch (err: any) {
        ctx.ui.notify(`Re-index failed: ${err.message}`, "error");
      }
    },
  });

  // ------------------------------------------------------------------
  // Search tool
  // ------------------------------------------------------------------

  const searchParams = Type.Object({
    query: Type.String({ description: "Natural language search query" }),
    limit: Type.Optional(
      Type.Number({
        description: "Max results to return (default 8, max 20)",
      })
    ),
  });
  type SearchDetails = { resultCount?: number; indexSize?: number };

  pi.registerTool<typeof searchParams, SearchDetails>({
    name: "knowledge_search",
    label: "Knowledge Search",
    description:
      "Semantic search over local knowledge files. Returns the most relevant file excerpts for a natural language query. Use for finding past notes, investigations, decisions, documentation, and context. Prefer this over grep when you need conceptual or fuzzy matching rather than exact text.",
    promptGuidelines: [
      'Use knowledge_search for conceptual queries (e.g. "how did we handle X", "what was decided about Y"). Use grep/read for exact text or known filenames.',
    ],
    parameters: searchParams,
    async execute(toolCallId, params, signal) {
      const hasLocalIndex = index && index.size() > 0;
      const hasKB = !!kbSearcher;

      if (!hasLocalIndex && !hasKB) {
        const msg =
          !index && !kbSearcher
            ? "knowledge-search is not configured. The user can run /knowledge-search-setup to set it up."
            : !syncDone && index
              ? "Index is still syncing in the background. Try again in a moment."
              : "Index is empty.";
        return { content: [{ type: "text", text: msg }], details: {} };
      }

      const limit = Math.min(params.limit ?? 8, 20);

      try {
        // Search local index and Bedrock KBs in parallel
        const [localResults, kbResults] = await Promise.all([
          hasLocalIndex ? index!.search(params.query, limit, signal) : [],
          hasKB ? kbSearcher!.search(params.query, limit, signal) : [],
        ]);

        // Merge and sort by score, take top N
        const results = [...localResults, ...kbResults]
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);

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
            const heading = r.heading && r.heading !== "intro" ? ` > ${r.heading}` : "";
            return `### ${i + 1}. ${displayPath}${heading} (${score}% match)\n\n${r.excerpt}`;
          })
          .join("\n\n---\n\n");

        const indexInfo = hasLocalIndex
          ? `${index!.size()} files, ${index!.chunkCount()} chunks indexed`
          : "";
        const kbInfo = hasKB ? `${currentConfig!.knowledgeBases.length} knowledge base(s)` : "";
        const sourceInfo = [indexInfo, kbInfo].filter(Boolean).join(" + ");
        const header = `Found ${results.length} results for "${params.query}" (${sourceInfo}):\n\n`;

        return {
          content: [{ type: "text", text: header + output }],
          details: { resultCount: results.length, indexSize: index?.size() ?? 0 },
        };
      } catch (err: any) {
        throw new Error(`knowledge-search failed: ${err.message}`);
      }
    },
  });

  // ------------------------------------------------------------------
  // Read tool — resolve a note reference (wikilink, basename, fuzzy name)
  // to a file in the indexed vault and return its content. Complements
  // knowledge_search by letting the agent pull a known note without first
  // running grep/find to get an absolute path.
  // ------------------------------------------------------------------
  const readParams = Type.Object({
    name: Type.String({
      description:
        "Note reference: filename, basename, relative path, or [[wikilink]]. Examples: 'evergreen/hybrid-search', 'Hybrid search.md', '[[Hybrid search]]', '[[evergreen/hybrid-search|alias]]'.",
    }),
    max_bytes: Type.Optional(
      Type.Number({
        description: "Truncate output to at most this many bytes (default 65536).",
      })
    ),
  });
  type ReadDetails = { resolvedPath?: string; candidates?: string[]; truncated?: boolean };

  pi.registerTool<typeof readParams, ReadDetails>({
    name: "kb_read",
    label: "KB Read",
    description:
      "Read a note from the knowledge base by name, relative path, or [[wikilink]]. Resolves fuzzy references without needing an absolute path — use this when you know the note's title/filename but not its full path on disk.",
    promptGuidelines: [
      "Use kb_read when a note is referenced by name or [[wikilink]] — don't run find/grep first.",
      "Use the standard `read` tool for non-indexed files or when you already have an absolute path.",
    ],
    parameters: readParams,
    async execute(_toolCallId, params) {
      if (!index || index.size() === 0) {
        const msg = !index
          ? "knowledge-search is not configured. Run /knowledge-search-setup to set it up."
          : !syncDone
            ? "Index is still syncing in the background. Try again in a moment."
            : "Index is empty.";
        return { content: [{ type: "text", text: msg }], details: {} };
      }

      const result = resolveNote(params.name, index.listFiles(), {
        fileExtensions: currentConfig?.fileExtensions,
        cwd: sessionCwd,
      });

      if (result.matches.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No note matched "${result.normalizedRef}". Try knowledge_search with a topic query to find related notes.`,
            },
          ],
          details: {},
        };
      }

      if (!result.unique && result.matches.length > 1) {
        const home = process.env.HOME || "";
        const listed = result.matches
          .map((m, i) => {
            const display = home && m.absPath.startsWith(home) ? m.absPath.replace(home, "~") : m.absPath;
            return `${i + 1}. ${display}  _(${m.reason})_`;
          })
          .join("\n");
        return {
          content: [
            {
              type: "text",
              text:
                `"${result.normalizedRef}" is ambiguous. ${result.matches.length} candidates:\n\n${listed}\n\n` +
                `Call kb_read again with a more specific path (e.g. the exact relative path) to disambiguate.`,
            },
          ],
          details: { candidates: result.matches.map((m) => m.absPath) },
        };
      }

      const match = result.matches[0];
      let note;
      try {
        note = readNote(match.absPath, {
          maxBytes: params.max_bytes,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to read ${match.absPath}: ${msg}` }],
          details: {},
        };
      }

      const home = process.env.HOME || "";
      const display = home && note.path.startsWith(home) ? note.path.replace(home, "~") : note.path;
      const truncNote = note.truncated
        ? `\n\n_(truncated: showing first ${note.content.length} of ${note.totalBytes} bytes)_`
        : "";
      const section = result.subheading ? ` — section "${result.subheading}"` : "";
      // When a single low-confidence match slips through (fuzzy substring), flag
      // the reason so the agent can decide whether to trust the result or refine
      // the reference. High-confidence tiers are resolved silently.
      const fuzzyNote = !result.unique
        ? `\n\n_(fuzzy match via ${match.reason} — if this isn't the note you meant, re-run kb_read with a more specific path)_`
        : "";
      const header = `# ${display}${section}${truncNote}${fuzzyNote}\n\n`;

      return {
        content: [{ type: "text", text: header + note.content }],
        details: {
          resolvedPath: match.absPath,
          truncated: note.truncated,
        },
      };
    },
  });
}

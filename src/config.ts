import * as fs from "node:fs";
import * as path from "node:path";
import type { KnowledgeBaseConfig } from "./kb-searcher";

export interface Config {
  /** Directories to index */
  dirs: string[];
  /** File extensions to index (with dots) */
  fileExtensions: string[];
  /** Directory names to skip */
  excludeDirs: string[];
  /** Embedding dimensions */
  dimensions: number;
  /** Embedding provider config (required for local file indexing) */
  provider: ProviderConfig | null;
  /** Where to store the index */
  indexDir: string;
  /** Optional Bedrock Knowledge Bases to search */
  knowledgeBases: KnowledgeBaseConfig[];
}

export type ProviderConfig =
  | { type: "openai"; apiKey: string; model: string }
  | { type: "openai-compatible"; apiKey?: string; model: string; baseUrl: string }
  | { type: "bedrock"; profile: string; region: string; model: string }
  | { type: "ollama"; url: string; model: string };

/** Raw shape stored in the config file. */
export interface ConfigFile {
  dirs?: string[];
  fileExtensions?: string[];
  excludeDirs?: string[];
  dimensions?: number;
  knowledgeBases?: KnowledgeBaseConfig[];
  provider?:
    | { type: "openai"; apiKey?: string; model?: string }
    | { type: "openai-compatible"; apiKey?: string; model?: string; baseUrl?: string }
    | { type: "bedrock"; profile?: string; region?: string; model?: string }
    | { type: "ollama"; url?: string; model?: string };
}

const CONFIG_PATH =
  process.env.KNOWLEDGE_SEARCH_CONFIG ||
  path.join(process.env.HOME || "/tmp", ".pi", "knowledge-search.json");

export function getConfigPath(): string {
  return CONFIG_PATH;
}

/**
 * Load config from file, with env var overrides.
 * Returns null if no config file exists (needs setup).
 */
export function loadConfig(): Config | null {
  // Try config file first
  let file: ConfigFile | null = null;
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    } catch {
      // Corrupted file
    }
  }

  // Check env var fallback for dirs
  const envDirs = process.env.KNOWLEDGE_SEARCH_DIRS;

  const hasKBs = (file?.knowledgeBases?.length ?? 0) > 0;

  if (!file && !envDirs) {
    return null; // Not configured yet
  }

  // Build config: file values, then env overrides
  const home = process.env.HOME || "/tmp";
  const resolvePath = (p: string) => p.replace(/^~/, home);

  const dirs = (envDirs ? envDirs.split(",").map((d) => d.trim()) : file?.dirs ?? [])
    .map(resolvePath)
    .filter(Boolean);

  if (dirs.length === 0 && !hasKBs) return null;

  const fileExtensions = envStr("KNOWLEDGE_SEARCH_EXTENSIONS") ?.split(",").map((e) => e.trim()) ??
    file?.fileExtensions ?? [".md", ".txt"];

  const excludeDirs = envStr("KNOWLEDGE_SEARCH_EXCLUDE")?.split(",").map((d) => d.trim()) ??
    file?.excludeDirs ?? ["node_modules", ".git", ".obsidian", ".trash"];

  const dimensions = envInt("KNOWLEDGE_SEARCH_DIMENSIONS") ??
    file?.dimensions ?? 512;

  const providerType = envStr("KNOWLEDGE_SEARCH_PROVIDER") ??
    file?.provider?.type;

  let provider: ProviderConfig | null = null;
  if (providerType) {
  switch (providerType) {
    case "openai": {
      const apiKey =
        envStr("KNOWLEDGE_SEARCH_OPENAI_API_KEY") ??
        process.env.OPENAI_API_KEY ??
        (file?.provider?.type === "openai" ? file.provider.apiKey : undefined);
      if (!apiKey) {
        throw new Error(
          "OpenAI API key required. Run /knowledge-search-setup or set OPENAI_API_KEY."
        );
      }
      provider = {
        type: "openai",
        apiKey,
        model:
          envStr("KNOWLEDGE_SEARCH_OPENAI_MODEL") ??
          (file?.provider?.type === "openai"
            ? file.provider.model
            : undefined) ??
          "text-embedding-3-small",
      };
      break;
    }
    case "openai-compatible": {
      const compatApiKey =
        envStr("KNOWLEDGE_SEARCH_COMPAT_API_KEY") ??
        process.env.OPENAI_API_KEY ??
        (file?.provider?.type === "openai-compatible"
          ? file.provider.apiKey
          : undefined);
      const compatBaseUrl =
        envStr("KNOWLEDGE_SEARCH_COMPAT_BASE_URL") ??
        (file?.provider?.type === "openai-compatible"
          ? file.provider.baseUrl
          : undefined);
      if (!compatBaseUrl) {
        throw new Error(
          'OpenAI-compatible requires baseUrl. Set KNOWLEDGE_SEARCH_COMPAT_BASE_URL or provide it in your knowledge-search.json config.'
        );
      }
      provider = {
        type: "openai-compatible",
        apiKey: compatApiKey,
        model:
          envStr("KNOWLEDGE_SEARCH_COMPAT_MODEL") ??
          (file?.provider?.type === "openai-compatible"
            ? file.provider.model
            : undefined) ??
          "text-embedding-3-small",
        baseUrl: compatBaseUrl,
      };
      break;
    }
    case "bedrock":
      provider = {
        type: "bedrock",
        profile:
          envStr("KNOWLEDGE_SEARCH_BEDROCK_PROFILE") ??
          (file?.provider?.type === "bedrock"
            ? file.provider.profile
            : undefined) ??
          "default",
        region:
          envStr("KNOWLEDGE_SEARCH_BEDROCK_REGION") ??
          (file?.provider?.type === "bedrock"
            ? file.provider.region
            : undefined) ??
          "us-east-1",
        model:
          envStr("KNOWLEDGE_SEARCH_BEDROCK_MODEL") ??
          (file?.provider?.type === "bedrock"
            ? file.provider.model
            : undefined) ??
          "amazon.titan-embed-text-v2:0",
      };
      break;
    case "ollama":
      provider = {
        type: "ollama",
        url:
          envStr("KNOWLEDGE_SEARCH_OLLAMA_URL") ??
          (file?.provider?.type === "ollama"
            ? file.provider.url
            : undefined) ??
          "http://localhost:11434",
        model:
          envStr("KNOWLEDGE_SEARCH_OLLAMA_MODEL") ??
          (file?.provider?.type === "ollama"
            ? file.provider.model
            : undefined) ??
          "nomic-embed-text",
      };
      break;
    default:
      throw new Error(
        `Unknown provider: "${providerType}". Use "openai", "openai-compatible", "bedrock", or "ollama".`
      );
  }
  } // end if (providerType)

  const indexDir =
    envStr("KNOWLEDGE_SEARCH_INDEX_DIR") ??
    path.join(home, ".pi", "knowledge-search");

  return {
    dirs,
    fileExtensions,
    excludeDirs: excludeDirs,
    dimensions,
    provider,
    indexDir,
    knowledgeBases: file?.knowledgeBases ?? [],
  };
}

/**
 * Save config to file.
 */
export function saveConfig(config: ConfigFile): void {
  const dir = path.dirname(CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

function envStr(key: string): string | undefined {
  const v = process.env[key]?.trim();
  return v || undefined;
}

function envInt(key: string): number | undefined {
  const v = envStr(key);
  return v ? parseInt(v, 10) : undefined;
}

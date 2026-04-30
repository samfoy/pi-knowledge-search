import { describe, it, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// CONFIG_PATH is evaluated at module load time from KNOWLEDGE_SEARCH_CONFIG env var.
// ESM hoists imports before top-level code, so we must use dynamic import().
// We set env var first, then dynamically import config.ts.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ks-config-test-"));
const configFile = path.join(tmpDir, "config.json");

// These env vars need to be saved/restored
const envKeys = [
  "KNOWLEDGE_SEARCH_CONFIG",
  "KNOWLEDGE_SEARCH_DIRS",
  "KNOWLEDGE_SEARCH_EXTENSIONS",
  "KNOWLEDGE_SEARCH_EXCLUDE",
  "KNOWLEDGE_SEARCH_DIMENSIONS",
  "KNOWLEDGE_SEARCH_PROVIDER",
  "KNOWLEDGE_SEARCH_OPENAI_API_KEY",
  "KNOWLEDGE_SEARCH_OPENAI_MODEL",
  "KNOWLEDGE_SEARCH_COMPAT_API_KEY",
  "KNOWLEDGE_SEARCH_COMPAT_BASE_URL",
  "KNOWLEDGE_SEARCH_COMPAT_MODEL",
  "KNOWLEDGE_SEARCH_BEDROCK_PROFILE",
  "KNOWLEDGE_SEARCH_BEDROCK_REGION",
  "KNOWLEDGE_SEARCH_BEDROCK_MODEL",
  "KNOWLEDGE_SEARCH_OLLAMA_URL",
  "KNOWLEDGE_SEARCH_OLLAMA_MODEL",
  "KNOWLEDGE_SEARCH_INDEX_DIR",
  "OPENAI_API_KEY",
];

let loadConfig: typeof import("./config.js")["loadConfig"];
let getConfigPath: typeof import("./config.js")["getConfigPath"];
let saveConfig: typeof import("./config.js")["saveConfig"];

const originalEnv: Record<string, string | undefined> = {};

describe("config", () => {
  before(async () => {
    // Save ALL env state
    for (const key of envKeys) {
      originalEnv[key] = process.env[key];
    }
    // Set config path BEFORE importing config module
    process.env.KNOWLEDGE_SEARCH_CONFIG = configFile;
    // Clear interfering env vars
    for (const key of envKeys) {
      if (key !== "KNOWLEDGE_SEARCH_CONFIG" && key !== "HOME") {
        delete process.env[key];
      }
    }

    // Dynamic import so CONFIG_PATH picks up our env var
    const configModule = await import("./config.js");
    loadConfig = configModule.loadConfig;
    getConfigPath = configModule.getConfigPath;
    saveConfig = configModule.saveConfig;
  });

  beforeEach(() => {
    // Clear all knowledge search env vars except CONFIG
    for (const key of envKeys) {
      if (key !== "KNOWLEDGE_SEARCH_CONFIG") {
        delete process.env[key];
      }
    }
    // Remove config file if exists
    try { fs.unlinkSync(configFile); } catch {}
  });

  after(() => {
    // Restore env
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("getConfigPath returns the env-configured path", () => {
    assert.equal(getConfigPath(), configFile);
  });

  it("returns null when no config file and no env vars", () => {
    const config = loadConfig();
    assert.equal(config, null);
  });

  it("loads valid config from file", () => {
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        dirs: ["/tmp/test-docs"],
        fileExtensions: [".md"],
        excludeDirs: ["node_modules"],
        dimensions: 256,
        provider: {
          type: "openai",
          apiKey: "sk-test-key-123",
          model: "text-embedding-3-small",
        },
      })
    );

    const config = loadConfig();
    assert.notEqual(config, null);
    assert.deepStrictEqual(config!.dirs, ["/tmp/test-docs"]);
    assert.deepStrictEqual(config!.fileExtensions, [".md"]);
    assert.equal(config!.dimensions, 256);
    assert.equal(config!.provider.type, "openai");
    if (config!.provider.type === "openai") {
      assert.equal(config!.provider.apiKey, "sk-test-key-123");
    }
  });

  it("returns null for corrupt JSON config file", () => {
    fs.writeFileSync(configFile, "{ this is not valid json }}}}");
    const config = loadConfig();
    assert.equal(config, null);
  });

  it("uses env var KNOWLEDGE_SEARCH_DIRS as fallback", () => {
    process.env.KNOWLEDGE_SEARCH_DIRS = "/tmp/dir-a, /tmp/dir-b";
    process.env.OPENAI_API_KEY = "sk-env-key";

    const config = loadConfig();
    assert.notEqual(config, null);
    assert.deepStrictEqual(config!.dirs, ["/tmp/dir-a", "/tmp/dir-b"]);
    assert.equal(config!.provider.type, "openai");
    if (config!.provider.type === "openai") {
      assert.equal(config!.provider.apiKey, "sk-env-key");
    }
  });

  it("applies default values for optional fields", () => {
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        dirs: ["/tmp/docs"],
        provider: { type: "openai", apiKey: "sk-test" },
      })
    );

    const config = loadConfig();
    assert.notEqual(config, null);
    assert.deepStrictEqual(config!.fileExtensions, [".md", ".txt"]);
    assert.ok(config!.excludeDirs.includes("node_modules"));
    assert.ok(config!.excludeDirs.includes(".git"));
    assert.ok(config!.excludeDirs.includes(".obsidian"));
    assert.ok(config!.excludeDirs.includes(".trash"));
    assert.equal(config!.dimensions, 512);
  });

  it("resolves ~ in directory paths", () => {
    const originalHome = process.env.HOME;
    process.env.HOME = "/home/testuser";

    fs.writeFileSync(
      configFile,
      JSON.stringify({
        dirs: ["~/Documents/notes"],
        provider: { type: "openai", apiKey: "sk-test" },
      })
    );

    try {
      const config = loadConfig();
      assert.notEqual(config, null);
      assert.deepStrictEqual(config!.dirs, ["/home/testuser/Documents/notes"]);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it("throws for openai provider without API key", () => {
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        dirs: ["/tmp/docs"],
        provider: { type: "openai" },
      })
    );

    assert.throws(() => loadConfig(), /API key required/);
  });

  it("configures bedrock provider", () => {
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        dirs: ["/tmp/docs"],
        provider: {
          type: "bedrock",
          profile: "my-profile",
          region: "us-west-2",
          model: "amazon.titan-embed-text-v2:0",
        },
      })
    );

    const config = loadConfig();
    assert.notEqual(config, null);
    assert.equal(config!.provider.type, "bedrock");
    if (config!.provider.type === "bedrock") {
      assert.equal(config!.provider.profile, "my-profile");
      assert.equal(config!.provider.region, "us-west-2");
    }
  });

  it("configures ollama provider", () => {
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        dirs: ["/tmp/docs"],
        provider: {
          type: "ollama",
          url: "http://localhost:11434",
          model: "nomic-embed-text",
        },
      })
    );

    const config = loadConfig();
    assert.notEqual(config, null);
    assert.equal(config!.provider.type, "ollama");
    if (config!.provider.type === "ollama") {
      assert.equal(config!.provider.url, "http://localhost:11434");
      assert.equal(config!.provider.model, "nomic-embed-text");
    }
  });

  it("throws for unknown provider type", () => {
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        dirs: ["/tmp/docs"],
        provider: { type: "unknown-provider" },
      })
    );

    assert.throws(() => loadConfig(), /Unknown provider/);
  });

  it("env vars override config file values", () => {
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        dirs: ["/tmp/file-dirs"],
        dimensions: 256,
        provider: { type: "openai", apiKey: "sk-file-key" },
      })
    );
    process.env.KNOWLEDGE_SEARCH_DIRS = "/tmp/env-dirs";
    process.env.KNOWLEDGE_SEARCH_DIMENSIONS = "1024";

    const config = loadConfig();
    assert.notEqual(config, null);
    assert.deepStrictEqual(config!.dirs, ["/tmp/env-dirs"]);
    assert.equal(config!.dimensions, 1024);
  });

  it("env var overrides provider API key", () => {
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        dirs: ["/tmp/docs"],
        provider: { type: "openai", apiKey: "sk-file-key" },
      })
    );
    process.env.KNOWLEDGE_SEARCH_OPENAI_API_KEY = "sk-env-override";

    const config = loadConfig();
    assert.notEqual(config, null);
    if (config!.provider.type === "openai") {
      assert.equal(config!.provider.apiKey, "sk-env-override");
    }
  });

  it("saveConfig writes valid JSON to config path", () => {
    const configData = {
      dirs: ["/tmp/saved"],
      provider: { type: "openai" as const, apiKey: "sk-saved" },
    };
    saveConfig(configData);

    const raw = fs.readFileSync(configFile, "utf-8");
    const parsed = JSON.parse(raw);
    assert.deepStrictEqual(parsed.dirs, ["/tmp/saved"]);
    assert.equal(parsed.provider.type, "openai");
  });

  it("returns null when dirs resolve to empty", () => {
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        dirs: [],
        provider: { type: "openai", apiKey: "sk-test" },
      })
    );

    const config = loadConfig();
    assert.equal(config, null);
  });

  it("bedrock provider uses defaults when fields missing", () => {
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        dirs: ["/tmp/docs"],
        provider: { type: "bedrock" },
      })
    );

    const config = loadConfig();
    assert.notEqual(config, null);
    if (config!.provider.type === "bedrock") {
      assert.equal(config!.provider.profile, "default");
      assert.equal(config!.provider.region, "us-east-1");
      assert.equal(config!.provider.model, "amazon.titan-embed-text-v2:0");
    }
  });

  it("ollama provider uses defaults when fields missing", () => {
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        dirs: ["/tmp/docs"],
        provider: { type: "ollama" },
      })
    );

    const config = loadConfig();
    assert.notEqual(config, null);
    if (config!.provider.type === "ollama") {
      assert.equal(config!.provider.url, "http://localhost:11434");
      assert.equal(config!.provider.model, "nomic-embed-text");
    }
  });

  // ---------------------------------------------------------------------
  // openai-compatible provider
  // ---------------------------------------------------------------------

  it("configures openai-compatible provider from file", () => {
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        dirs: ["/tmp/docs"],
        provider: {
          type: "openai-compatible",
          baseUrl: "http://127.0.0.1:8080",
          apiKey: "local-key",
          model: "qwen3-embeddings",
        },
      })
    );

    const config = loadConfig();
    assert.notEqual(config, null);
    assert.equal(config!.provider.type, "openai-compatible");
    if (config!.provider.type === "openai-compatible") {
      assert.equal(config!.provider.baseUrl, "http://127.0.0.1:8080");
      assert.equal(config!.provider.apiKey, "local-key");
      assert.equal(config!.provider.model, "qwen3-embeddings");
    }
  });

  it("openai-compatible provider defaults model when omitted", () => {
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        dirs: ["/tmp/docs"],
        provider: {
          type: "openai-compatible",
          baseUrl: "http://127.0.0.1:8080",
        },
      })
    );

    const config = loadConfig();
    assert.notEqual(config, null);
    if (config!.provider.type === "openai-compatible") {
      assert.equal(config!.provider.model, "text-embedding-3-small");
      assert.equal(config!.provider.apiKey, undefined);
    }
  });

  it("openai-compatible provider throws when baseUrl missing", () => {
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        dirs: ["/tmp/docs"],
        provider: { type: "openai-compatible", apiKey: "x" },
      })
    );

    assert.throws(() => loadConfig(), /baseUrl/);
  });

  it("openai-compatible env vars override file values", () => {
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        dirs: ["/tmp/docs"],
        provider: {
          type: "openai-compatible",
          baseUrl: "http://file-host:1234",
          apiKey: "file-key",
          model: "file-model",
        },
      })
    );
    process.env.KNOWLEDGE_SEARCH_COMPAT_BASE_URL = "http://env-host:9999";
    process.env.KNOWLEDGE_SEARCH_COMPAT_API_KEY = "env-key";
    process.env.KNOWLEDGE_SEARCH_COMPAT_MODEL = "env-model";

    const config = loadConfig();
    assert.notEqual(config, null);
    if (config!.provider.type === "openai-compatible") {
      assert.equal(config!.provider.baseUrl, "http://env-host:9999");
      assert.equal(config!.provider.apiKey, "env-key");
      assert.equal(config!.provider.model, "env-model");
    }
  });

  it("openai-compatible does NOT fall back to OPENAI_API_KEY (credential-leak guard)", () => {
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        dirs: ["/tmp/docs"],
        provider: {
          type: "openai-compatible",
          baseUrl: "http://127.0.0.1:8080",
        },
      })
    );
    process.env.OPENAI_API_KEY = "sk-real-openai-key";

    const config = loadConfig();
    assert.notEqual(config, null);
    if (config!.provider.type === "openai-compatible") {
      // Real OpenAI key must NOT be bled into third-party endpoint
      assert.equal(config!.provider.apiKey, undefined);
    }
  });

  it("throws a helpful error if baseUrl is set on type: openai", () => {
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        dirs: ["/tmp/docs"],
        provider: {
          type: "openai",
          apiKey: "sk-test",
          baseUrl: "http://127.0.0.1:8080",
        },
      })
    );

    assert.throws(() => loadConfig(), /openai-compatible/);
  });
});

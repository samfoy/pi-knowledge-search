/**
 * Tests for project-local storage via pi-knowledge-search.localPath
 * and pi-total-recall.localPath cascade.
 *
 * Resolution order (highest priority first):
 *   1. Env var (KNOWLEDGE_SEARCH_CONFIG / KNOWLEDGE_SEARCH_INDEX_DIR)
 *   2. {cwd}/.pi/settings.json → "pi-knowledge-search".localPath
 *   3. {cwd}/.pi/settings.json → "pi-total-recall".localPath → {base}/knowledge-search
 *   4. Global default under ~/.pi/
 */
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// All env vars that can interfere with path resolution.
const envKeys = [
  "KNOWLEDGE_SEARCH_CONFIG",
  "KNOWLEDGE_SEARCH_INDEX_DIR",
  "KNOWLEDGE_SEARCH_DIRS",
  "KNOWLEDGE_SEARCH_CWD",
  "OPENAI_API_KEY",
  "HOME",
];

const originalEnv: Record<string, string | undefined> = {};
let tmpHome: string;
let tmpProject: string;
let tmpLocal: string;
let tmpCascade: string;

// Dynamic imports so module-level env reads stay current.
let resolveLocalBase: (typeof import("./config.js"))["resolveLocalBase"];
let getConfigPath: (typeof import("./config.js"))["getConfigPath"];
let getIndexDir: (typeof import("./config.js"))["getIndexDir"];
let loadConfig: (typeof import("./config.js"))["loadConfig"];
let saveConfig: (typeof import("./config.js"))["saveConfig"];

function writeProjectSettings(obj: Record<string, unknown>): void {
  const dir = path.join(tmpProject, ".pi");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(obj), "utf-8");
}

describe("config.localPath resolution", () => {
  before(async () => {
    for (const k of envKeys) originalEnv[k] = process.env[k];

    // Fresh temp HOME for deterministic global defaults.
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ks-home-"));
    tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "ks-proj-"));
    tmpLocal = fs.mkdtempSync(path.join(os.tmpdir(), "ks-local-"));
    tmpCascade = fs.mkdtempSync(path.join(os.tmpdir(), "ks-cascade-"));

    process.env.HOME = tmpHome;
    delete process.env.KNOWLEDGE_SEARCH_CONFIG;
    delete process.env.KNOWLEDGE_SEARCH_INDEX_DIR;
    delete process.env.KNOWLEDGE_SEARCH_DIRS;
    delete process.env.KNOWLEDGE_SEARCH_CWD;
    delete process.env.OPENAI_API_KEY;

    const mod = await import("./config.js");
    resolveLocalBase = mod.resolveLocalBase;
    getConfigPath = mod.getConfigPath;
    getIndexDir = mod.getIndexDir;
    loadConfig = mod.loadConfig;
    saveConfig = mod.saveConfig;
  });

  beforeEach(() => {
    delete process.env.KNOWLEDGE_SEARCH_CONFIG;
    delete process.env.KNOWLEDGE_SEARCH_INDEX_DIR;
    delete process.env.KNOWLEDGE_SEARCH_DIRS;
    delete process.env.KNOWLEDGE_SEARCH_CWD;
    delete process.env.OPENAI_API_KEY;
    // Clear any prior settings file.
    try {
      fs.rmSync(path.join(tmpProject, ".pi"), { recursive: true, force: true });
    } catch {}
    // Clear any config files the previous test created.
    try {
      fs.rmSync(path.join(tmpHome, ".pi"), { recursive: true, force: true });
    } catch {}
    try {
      fs.rmSync(path.join(tmpLocal, "config.json"), { force: true });
    } catch {}
    try {
      fs.rmSync(path.join(tmpCascade, "knowledge-search", "config.json"), { force: true });
    } catch {}
  });

  after(() => {
    for (const k of envKeys) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpProject, { recursive: true, force: true });
    fs.rmSync(tmpLocal, { recursive: true, force: true });
    fs.rmSync(tmpCascade, { recursive: true, force: true });
  });

  // ─── resolveLocalBase ──────────────────────────────────────────────

  it("resolveLocalBase returns null when cwd is undefined", () => {
    assert.equal(resolveLocalBase(undefined), null);
  });

  it("resolveLocalBase returns null when no settings.json", () => {
    assert.equal(resolveLocalBase(tmpProject), null);
  });

  it("resolveLocalBase returns null for malformed settings.json", () => {
    fs.mkdirSync(path.join(tmpProject, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(tmpProject, ".pi", "settings.json"), "{ not json }}", "utf-8");
    assert.equal(resolveLocalBase(tmpProject), null);
  });

  it("resolveLocalBase returns null for empty settings.json", () => {
    writeProjectSettings({});
    assert.equal(resolveLocalBase(tmpProject), null);
  });

  it("resolveLocalBase returns null when pi-knowledge-search is present but empty", () => {
    writeProjectSettings({ "pi-knowledge-search": {} });
    assert.equal(resolveLocalBase(tmpProject), null);
  });

  it("resolveLocalBase returns null when localPath is empty string", () => {
    writeProjectSettings({ "pi-knowledge-search": { localPath: "" } });
    assert.equal(resolveLocalBase(tmpProject), null);
  });

  it("resolveLocalBase returns null when localPath is not a string", () => {
    writeProjectSettings({ "pi-knowledge-search": { localPath: 42 } });
    assert.equal(resolveLocalBase(tmpProject), null);
  });

  it("resolveLocalBase returns pi-knowledge-search.localPath when set", () => {
    writeProjectSettings({ "pi-knowledge-search": { localPath: tmpLocal } });
    assert.equal(resolveLocalBase(tmpProject), tmpLocal);
  });

  it("resolveLocalBase cascades from pi-total-recall.localPath", () => {
    writeProjectSettings({ "pi-total-recall": { localPath: tmpCascade } });
    assert.equal(resolveLocalBase(tmpProject), path.join(tmpCascade, "knowledge-search"));
  });

  it("resolveLocalBase: package-specific wins over cascade", () => {
    writeProjectSettings({
      "pi-knowledge-search": { localPath: tmpLocal },
      "pi-total-recall": { localPath: tmpCascade },
    });
    assert.equal(resolveLocalBase(tmpProject), tmpLocal);
  });

  // ─── getConfigPath ─────────────────────────────────────────────────

  it("getConfigPath: global default when no cwd and no env", () => {
    assert.equal(getConfigPath(), path.join(tmpHome, ".pi", "knowledge-search.json"));
  });

  it("getConfigPath: env var wins over everything", () => {
    process.env.KNOWLEDGE_SEARCH_CONFIG = "/explicit/override.json";
    writeProjectSettings({ "pi-knowledge-search": { localPath: tmpLocal } });
    assert.equal(getConfigPath(tmpProject), "/explicit/override.json");
  });

  it("getConfigPath: package localPath resolves to {base}/config.json", () => {
    writeProjectSettings({ "pi-knowledge-search": { localPath: tmpLocal } });
    assert.equal(getConfigPath(tmpProject), path.join(tmpLocal, "config.json"));
  });

  it("getConfigPath: pi-total-recall cascade resolves to {base}/knowledge-search/config.json", () => {
    writeProjectSettings({ "pi-total-recall": { localPath: tmpCascade } });
    assert.equal(
      getConfigPath(tmpProject),
      path.join(tmpCascade, "knowledge-search", "config.json")
    );
  });

  it("getConfigPath: falls back to global when cwd has no settings", () => {
    assert.equal(
      getConfigPath(tmpProject),
      path.join(tmpHome, ".pi", "knowledge-search.json")
    );
  });

  // ─── getIndexDir ───────────────────────────────────────────────────

  it("getIndexDir: global default when no cwd and no env", () => {
    assert.equal(getIndexDir(), path.join(tmpHome, ".pi", "knowledge-search"));
  });

  it("getIndexDir: env var wins over everything", () => {
    process.env.KNOWLEDGE_SEARCH_INDEX_DIR = "/explicit/index-override";
    writeProjectSettings({ "pi-knowledge-search": { localPath: tmpLocal } });
    assert.equal(getIndexDir(tmpProject), "/explicit/index-override");
  });

  it("getIndexDir: package localPath resolves to {base}/index", () => {
    writeProjectSettings({ "pi-knowledge-search": { localPath: tmpLocal } });
    assert.equal(getIndexDir(tmpProject), path.join(tmpLocal, "index"));
  });

  it("getIndexDir: pi-total-recall cascade resolves to {base}/knowledge-search/index", () => {
    writeProjectSettings({ "pi-total-recall": { localPath: tmpCascade } });
    assert.equal(
      getIndexDir(tmpProject),
      path.join(tmpCascade, "knowledge-search", "index")
    );
  });

  // ─── loadConfig integration ────────────────────────────────────────

  it("loadConfig: reads config from package-local path when localPath set", () => {
    writeProjectSettings({ "pi-knowledge-search": { localPath: tmpLocal } });
    fs.writeFileSync(
      path.join(tmpLocal, "config.json"),
      JSON.stringify({
        dirs: ["/tmp/project-docs"],
        provider: { type: "openai", apiKey: "sk-local" },
      }),
      "utf-8"
    );

    const config = loadConfig(tmpProject);
    assert.ok(config);
    assert.deepStrictEqual(config.dirs, ["/tmp/project-docs"]);
    assert.equal(config.indexDir, path.join(tmpLocal, "index"));
  });

  it("loadConfig: reads config from cascade sub-path when pi-total-recall.localPath set", () => {
    writeProjectSettings({ "pi-total-recall": { localPath: tmpCascade } });
    fs.mkdirSync(path.join(tmpCascade, "knowledge-search"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpCascade, "knowledge-search", "config.json"),
      JSON.stringify({
        dirs: ["/tmp/cascade-docs"],
        provider: { type: "openai", apiKey: "sk-cascade" },
      }),
      "utf-8"
    );

    const config = loadConfig(tmpProject);
    assert.ok(config);
    assert.deepStrictEqual(config.dirs, ["/tmp/cascade-docs"]);
    assert.equal(config.indexDir, path.join(tmpCascade, "knowledge-search", "index"));
  });

  it("loadConfig: falls through to global when localPath set but {localPath}/config.json missing", () => {
    // localPath configured, but no config file yet → behaves like "not configured"
    writeProjectSettings({ "pi-knowledge-search": { localPath: tmpLocal } });
    assert.equal(loadConfig(tmpProject), null);
  });

  it("loadConfig: without cwd, still works against global defaults (back-compat)", () => {
    // Write a global config under tmpHome
    const globalDir = path.join(tmpHome, ".pi");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, "knowledge-search.json"),
      JSON.stringify({
        dirs: ["/tmp/global-docs"],
        provider: { type: "openai", apiKey: "sk-global" },
      }),
      "utf-8"
    );

    const config = loadConfig();
    assert.ok(config);
    assert.deepStrictEqual(config.dirs, ["/tmp/global-docs"]);
    assert.equal(config.indexDir, path.join(tmpHome, ".pi", "knowledge-search"));
  });

  // ─── saveConfig integration ────────────────────────────────────────

  it("saveConfig: writes to package-local path when localPath set", () => {
    writeProjectSettings({ "pi-knowledge-search": { localPath: tmpLocal } });

    saveConfig(
      {
        dirs: ["/tmp/save-test"],
        provider: { type: "openai", apiKey: "sk-write" },
      },
      tmpProject
    );

    const written = path.join(tmpLocal, "config.json");
    assert.ok(fs.existsSync(written));
    const parsed = JSON.parse(fs.readFileSync(written, "utf-8"));
    assert.deepStrictEqual(parsed.dirs, ["/tmp/save-test"]);
  });

  it("saveConfig: writes to cascade sub-path when pi-total-recall.localPath set", () => {
    writeProjectSettings({ "pi-total-recall": { localPath: tmpCascade } });

    saveConfig(
      {
        dirs: ["/tmp/cascade-save"],
        provider: { type: "openai", apiKey: "sk-cascade" },
      },
      tmpProject
    );

    const written = path.join(tmpCascade, "knowledge-search", "config.json");
    assert.ok(fs.existsSync(written));
    const parsed = JSON.parse(fs.readFileSync(written, "utf-8"));
    assert.deepStrictEqual(parsed.dirs, ["/tmp/cascade-save"]);
  });

  it("saveConfig: creates parent directory automatically", () => {
    const freshBase = fs.mkdtempSync(path.join(os.tmpdir(), "ks-fresh-"));
    try {
      // Parent base exists but sub-dirs won't until we call.
      writeProjectSettings({
        "pi-total-recall": { localPath: path.join(freshBase, "nested", "deep") },
      });
      saveConfig(
        {
          dirs: ["/tmp/deep"],
          provider: { type: "openai", apiKey: "sk-deep" },
        },
        tmpProject
      );
      assert.ok(
        fs.existsSync(path.join(freshBase, "nested", "deep", "knowledge-search", "config.json"))
      );
    } finally {
      fs.rmSync(freshBase, { recursive: true, force: true });
    }
  });

  // ─── Back-compat smoke ─────────────────────────────────────────────

  it("back-compat: calls with no cwd behave identically to pre-localPath code", () => {
    // No settings file, no env overrides, no cwd → global default.
    assert.equal(getConfigPath(), path.join(tmpHome, ".pi", "knowledge-search.json"));
    assert.equal(getIndexDir(), path.join(tmpHome, ".pi", "knowledge-search"));
  });

  it("back-compat: undefined cwd with package-scoped settings in an unrelated project is ignored", () => {
    // Write settings in tmpProject but pass a different cwd → should NOT leak.
    writeProjectSettings({ "pi-knowledge-search": { localPath: tmpLocal } });
    const otherProject = fs.mkdtempSync(path.join(os.tmpdir(), "ks-other-"));
    try {
      assert.equal(getConfigPath(otherProject), path.join(tmpHome, ".pi", "knowledge-search.json"));
    } finally {
      fs.rmSync(otherProject, { recursive: true, force: true });
    }
  });
});

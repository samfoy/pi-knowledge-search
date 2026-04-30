#!/usr/bin/env node

// src/config.ts
import * as fs from "node:fs";
import * as path from "node:path";
var CONFIG_PATH = process.env.KNOWLEDGE_SEARCH_CONFIG || path.join(process.env.HOME || "/tmp", ".pi", "knowledge-search.json");
function loadConfig() {
  let file = null;
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    } catch {
    }
  }
  const envDirs = process.env.KNOWLEDGE_SEARCH_DIRS;
  const hasKBs = (file?.knowledgeBases?.length ?? 0) > 0;
  if (!file && !envDirs) {
    return null;
  }
  const home = process.env.HOME || "/tmp";
  const resolvePath = (p) => p.replace(/^~/, home);
  const dirs = (envDirs ? envDirs.split(",").map((d) => d.trim()) : file?.dirs ?? []).map(resolvePath).filter(Boolean);
  if (dirs.length === 0 && !hasKBs) return null;
  const fileExtensions = envStr("KNOWLEDGE_SEARCH_EXTENSIONS")?.split(",").map((e) => e.trim()) ?? file?.fileExtensions ?? [".md", ".txt"];
  const excludeDirs = envStr("KNOWLEDGE_SEARCH_EXCLUDE")?.split(",").map((d) => d.trim()) ?? file?.excludeDirs ?? ["node_modules", ".git", ".obsidian", ".trash"];
  const dimensions = envInt("KNOWLEDGE_SEARCH_DIMENSIONS") ?? file?.dimensions ?? 512;
  const providerType = envStr("KNOWLEDGE_SEARCH_PROVIDER") ?? file?.provider?.type ?? // Convenience default: if OPENAI_API_KEY is exported and nothing else
  // is configured, assume the user wants the openai provider.
  (process.env.OPENAI_API_KEY ? "openai" : void 0);
  let provider = null;
  if (providerType) {
    switch (providerType) {
      case "openai": {
        if (file?.provider?.type === "openai" && file.provider.baseUrl) {
          throw new Error(
            'Custom baseUrl is not supported on provider type "openai" (it would be silently ignored and requests would hit api.openai.com). Change "type" to "openai-compatible" to use a custom endpoint.'
          );
        }
        const apiKey = envStr("KNOWLEDGE_SEARCH_OPENAI_API_KEY") ?? process.env.OPENAI_API_KEY ?? (file?.provider?.type === "openai" ? file.provider.apiKey : void 0);
        if (!apiKey) {
          throw new Error(
            "OpenAI API key required. Run /knowledge-search-setup or set OPENAI_API_KEY."
          );
        }
        provider = {
          type: "openai",
          apiKey,
          model: envStr("KNOWLEDGE_SEARCH_OPENAI_MODEL") ?? (file?.provider?.type === "openai" ? file.provider.model : void 0) ?? "text-embedding-3-small"
        };
        break;
      }
      case "openai-compatible": {
        const compatApiKey = envStr("KNOWLEDGE_SEARCH_COMPAT_API_KEY") ?? (file?.provider?.type === "openai-compatible" ? file.provider.apiKey : void 0);
        const compatBaseUrl = envStr("KNOWLEDGE_SEARCH_COMPAT_BASE_URL") ?? (file?.provider?.type === "openai-compatible" ? file.provider.baseUrl : void 0);
        if (!compatBaseUrl) {
          throw new Error(
            "OpenAI-compatible requires baseUrl. Set KNOWLEDGE_SEARCH_COMPAT_BASE_URL or provide it in your knowledge-search.json config."
          );
        }
        provider = {
          type: "openai-compatible",
          apiKey: compatApiKey,
          model: envStr("KNOWLEDGE_SEARCH_COMPAT_MODEL") ?? (file?.provider?.type === "openai-compatible" ? file.provider.model : void 0) ?? "text-embedding-3-small",
          baseUrl: compatBaseUrl
        };
        break;
      }
      case "bedrock":
        provider = {
          type: "bedrock",
          profile: envStr("KNOWLEDGE_SEARCH_BEDROCK_PROFILE") ?? (file?.provider?.type === "bedrock" ? file.provider.profile : void 0) ?? "default",
          region: envStr("KNOWLEDGE_SEARCH_BEDROCK_REGION") ?? (file?.provider?.type === "bedrock" ? file.provider.region : void 0) ?? "us-east-1",
          model: envStr("KNOWLEDGE_SEARCH_BEDROCK_MODEL") ?? (file?.provider?.type === "bedrock" ? file.provider.model : void 0) ?? "amazon.titan-embed-text-v2:0"
        };
        break;
      case "ollama":
        provider = {
          type: "ollama",
          url: envStr("KNOWLEDGE_SEARCH_OLLAMA_URL") ?? (file?.provider?.type === "ollama" ? file.provider.url : void 0) ?? "http://localhost:11434",
          model: envStr("KNOWLEDGE_SEARCH_OLLAMA_MODEL") ?? (file?.provider?.type === "ollama" ? file.provider.model : void 0) ?? "nomic-embed-text"
        };
        break;
      default:
        throw new Error(
          `Unknown provider: "${providerType}". Use "openai", "openai-compatible", "bedrock", or "ollama".`
        );
    }
  }
  const indexDir = envStr("KNOWLEDGE_SEARCH_INDEX_DIR") ?? path.join(home, ".pi", "knowledge-search");
  return {
    dirs,
    fileExtensions,
    excludeDirs,
    dimensions,
    provider,
    indexDir,
    knowledgeBases: file?.knowledgeBases ?? []
  };
}
function envStr(key) {
  const v = process.env[key]?.trim();
  return v || void 0;
}
function envInt(key) {
  const v = envStr(key);
  return v ? parseInt(v, 10) : void 0;
}

// src/embedder.ts
function createEmbedder(config2, dimensions) {
  switch (config2.type) {
    case "openai":
      return new OpenAIEmbedder(config2.apiKey, config2.model, dimensions, void 0);
    case "openai-compatible":
      return new OpenAIEmbedder(config2.apiKey ?? "", config2.model, dimensions, config2.baseUrl);
    case "bedrock":
      return new BedrockEmbedder(config2.profile, config2.region, config2.model, dimensions);
    case "ollama":
      return new OllamaEmbedder(config2.url, config2.model);
  }
}
function truncate(text, maxChars = 1e4) {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}
var RETRY_DELAYS = [1e3, 2e3, 4e3];
async function withRateLimitRetry(fn, label) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const is429 = err?.message?.includes("429") || err?.name === "ThrottlingException" || err?.$metadata?.httpStatusCode === 429;
      if (is429 && attempt < RETRY_DELAYS.length) {
        const delay = RETRY_DELAYS[attempt];
        console.error(
          `knowledge-search: ${label} rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${RETRY_DELAYS.length})`
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}
async function parallelMap(items, fn, concurrency, signal) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      if (signal?.aborted) throw new Error("Aborted");
      const idx = cursor++;
      results[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}
var OpenAIEmbedder = class {
  apiKey;
  model;
  dimensions;
  endpoint;
  constructor(apiKey, model, dimensions, baseUrl) {
    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = dimensions;
    if (baseUrl) {
      this.endpoint = `${baseUrl.replace(/\/$/, "")}/v1/embeddings`;
    } else {
      this.endpoint = `https://api.openai.com/v1/embeddings`;
    }
  }
  async embed(text, signal) {
    const results = await this.embedBatch([text], signal);
    if (!results[0]) throw new Error("Embedding failed \u2014 provider returned no vector");
    return results[0];
  }
  async embedBatch(texts, signal) {
    const BATCH = 100;
    const results = new Array(texts.length);
    for (let i = 0; i < texts.length; i += BATCH) {
      if (signal?.aborted) throw new Error("Aborted");
      const batch = texts.slice(i, i + BATCH).map((t) => truncate(t));
      try {
        const json = await withRateLimitRetry(async () => {
          const res = await fetch(this.endpoint, {
            method: "POST",
            headers: {
              ...this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              input: batch,
              model: this.model,
              dimensions: this.dimensions
            }),
            signal
          });
          if (!res.ok) {
            const body = await res.text();
            throw new Error(`OpenAI API ${res.status}: ${body.slice(0, 200)}`);
          }
          return await res.json();
        }, "embedding");
        for (const item of json.data) {
          results[i + item.index] = item.embedding;
        }
      } catch (err) {
        for (let j = 0; j < batch.length; j++) {
          results[i + j] = null;
        }
        const label = this.endpoint.includes("api.openai.com") ? "OpenAI" : `Embedding (${this.endpoint})`;
        console.error(`${label} batch embedding failed: ${err.message}`);
      }
    }
    return results;
  }
};
var BedrockEmbedder = class {
  client;
  // Lazy-loaded to avoid hard dep if not using Bedrock
  model;
  dimensions;
  clientPromise;
  constructor(profile, region, model, dimensions) {
    this.model = model;
    this.dimensions = dimensions;
    this.clientPromise = (async () => {
      const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
      const { fromIni } = await import("@aws-sdk/credential-providers");
      return new BedrockRuntimeClient({
        region,
        credentials: fromIni({ profile })
      });
    })();
  }
  async embed(text, signal) {
    const results = await this.embedBatch([text], signal);
    if (!results[0]) throw new Error("Embedding failed \u2014 provider returned no vector");
    return results[0];
  }
  async embedBatch(texts, signal, concurrency = 10) {
    const client = await this.clientPromise;
    return parallelMap(
      texts,
      async (text) => {
        try {
          return await this.callBedrock(client, text);
        } catch (err) {
          console.error(`Bedrock embedding failed (${text.slice(0, 50)}...): ${err.message}`);
          return null;
        }
      },
      concurrency,
      signal
    );
  }
  async callBedrock(client, text) {
    return withRateLimitRetry(async () => {
      const { InvokeModelCommand } = await import("@aws-sdk/client-bedrock-runtime");
      const body = JSON.stringify({
        inputText: truncate(text),
        dimensions: this.dimensions,
        normalize: true
      });
      const command = new InvokeModelCommand({
        modelId: this.model,
        contentType: "application/json",
        accept: "application/json",
        body: new TextEncoder().encode(body)
      });
      const response = await client.send(command);
      const responseBody = JSON.parse(new TextDecoder().decode(response.body));
      if (!responseBody.embedding) {
        throw new Error(
          "Unexpected Bedrock response: " + JSON.stringify(responseBody).slice(0, 200)
        );
      }
      return responseBody.embedding;
    }, "Bedrock embed");
  }
};
var OllamaEmbedder = class {
  url;
  model;
  constructor(url, model) {
    this.url = url.replace(/\/$/, "");
    this.model = model;
  }
  async embed(text, signal) {
    return withRateLimitRetry(async () => {
      const res = await fetch(`${this.url}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: truncate(text) }),
        signal
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ollama API ${res.status}: ${body.slice(0, 200)}`);
      }
      const json = await res.json();
      return json.embeddings[0];
    }, "Ollama embed");
  }
  async embedBatch(texts, signal, concurrency = 4) {
    return parallelMap(
      texts,
      async (text) => {
        try {
          return await this.embed(text, signal);
        } catch (err) {
          console.error(`Ollama embedding failed (${text.slice(0, 50)}...): ${err.message}`);
          return null;
        }
      },
      concurrency,
      signal
    );
  }
};

// src/index-store.ts
import * as fs2 from "node:fs";
import * as path2 from "node:path";

// src/chunker.ts
import remarkParse from "remark-parse";
import { unified } from "unified";
var LARGE_FILE_FAST_PATH_CHARS = 12e4;
function chunkMarkdown(content, maxChunkSize = 3e3, minChunkSize = 200) {
  if (!content || content.trim().length === 0) return [];
  if (content.length >= LARGE_FILE_FAST_PATH_CHARS) {
    return chunkMarkdownFast(content, maxChunkSize, minChunkSize);
  }
  const sections = splitByHeadings(content);
  if (sections.length === 0) return [];
  if (content.length <= maxChunkSize) {
    return [
      {
        text: content.trim(),
        heading: sections[0]?.heading ?? "intro",
        startLine: 0,
        charOffset: 0
      }
    ];
  }
  let rawChunks = [];
  for (const section of sections) {
    if (section.text.trim().length === 0) continue;
    if (section.text.length <= maxChunkSize) {
      rawChunks.push(section);
    } else {
      rawChunks.push(...splitByBlocks(section, maxChunkSize));
    }
  }
  rawChunks = rawChunks.flatMap(
    (chunk) => chunk.text.length <= maxChunkSize ? [chunk] : hardSplit(chunk, maxChunkSize, 200)
  );
  return mergeTiny(rawChunks, minChunkSize, maxChunkSize);
}
function chunkMarkdownFast(content, maxChunkSize, minChunkSize) {
  if (content.length <= maxChunkSize) {
    return [
      {
        text: content.trim(),
        heading: "intro",
        startLine: 0,
        charOffset: 0
      }
    ];
  }
  const starts = lineStartOffsets(content);
  const headingRegex = /^##+\s+(.+)$/gm;
  const headingMatches = [];
  for (const match of content.matchAll(headingRegex)) {
    const start = match.index ?? 0;
    headingMatches.push({
      start,
      startLine: lineFromOffset(start, starts),
      heading: (match[1] ?? "intro").trim() || "intro"
    });
  }
  const sections = [];
  if (headingMatches.length === 0) {
    sections.push({ text: content, heading: "intro", startLine: 0, charOffset: 0 });
  } else {
    if (headingMatches[0].start > 0) {
      sections.push({
        text: content.slice(0, headingMatches[0].start),
        heading: "intro",
        startLine: 0,
        charOffset: 0
      });
    }
    for (let i = 0; i < headingMatches.length; i++) {
      const start = headingMatches[i].start;
      const end = i + 1 < headingMatches.length ? headingMatches[i + 1].start : content.length;
      sections.push({
        text: content.slice(start, end),
        heading: headingMatches[i].heading,
        startLine: headingMatches[i].startLine,
        charOffset: start
      });
    }
  }
  let rawChunks = [];
  for (const section of sections) {
    if (section.text.trim().length === 0) continue;
    if (section.text.length <= maxChunkSize) {
      rawChunks.push(section);
      continue;
    }
    rawChunks.push(...splitByParagraphsFallback(section, maxChunkSize));
  }
  rawChunks = rawChunks.flatMap(
    (chunk) => chunk.text.length <= maxChunkSize ? [chunk] : hardSplit(chunk, maxChunkSize, 200)
  );
  return mergeTiny(rawChunks, minChunkSize, maxChunkSize);
}
function lineStartOffsets(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}
function offsetFromLine(line, starts) {
  if (!line || line <= 1) return 0;
  return starts[Math.min(line - 1, starts.length - 1)] ?? 0;
}
function lineFromOffset(offset, starts) {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const mid = low + high >> 1;
    if (starts[mid] <= offset) low = mid + 1;
    else high = mid - 1;
  }
  return Math.max(0, low - 1);
}
function headingText(node) {
  if (!node) return "";
  if (typeof node.value === "string") return node.value;
  if (!Array.isArray(node.children)) return "";
  return node.children.map((child) => headingText(child)).join("");
}
function splitByHeadings(content) {
  const tree = unified().use(remarkParse).parse(content);
  const starts = lineStartOffsets(content);
  const headings = (tree.children ?? []).filter((node) => node.type === "heading" && node.depth >= 2).map((node) => {
    const line = node.position?.start?.line;
    const start = offsetFromLine(line, starts);
    return {
      start,
      startLine: lineFromOffset(start, starts),
      heading: headingText(node).trim() || "intro"
    };
  }).sort((a, b) => a.start - b.start);
  if (headings.length === 0) {
    return [{ text: content, heading: "intro", startLine: 0, charOffset: 0 }];
  }
  const sections = [];
  if (headings[0].start > 0) {
    sections.push({
      text: content.slice(0, headings[0].start),
      heading: "intro",
      startLine: 0,
      charOffset: 0
    });
  }
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].start;
    const end = i + 1 < headings.length ? headings[i + 1].start : content.length;
    sections.push({
      text: content.slice(start, end),
      heading: headings[i].heading,
      startLine: headings[i].startLine,
      charOffset: start
    });
  }
  return sections;
}
function splitByBlocks(section, maxChunkSize) {
  const text = section.text;
  const tree = unified().use(remarkParse).parse(text);
  const starts = lineStartOffsets(text);
  const blocks = (tree.children ?? []).map((node) => {
    const startLine = node.position?.start?.line;
    const endLine = node.position?.end?.line;
    if (!startLine || !endLine) return null;
    return {
      start: offsetFromLine(startLine, starts),
      end: offsetFromLine(endLine + 1, starts)
    };
  }).filter((x) => Boolean(x)).sort((a, b) => a.start - b.start);
  if (blocks.length === 0) {
    return splitByParagraphsFallback(section, maxChunkSize);
  }
  const units = blocks.map((block, i) => ({
    start: i === 0 ? 0 : block.start,
    end: i + 1 < blocks.length ? blocks[i + 1].start : text.length
  }));
  const chunks = [];
  let currentText = "";
  let currentOffset = section.charOffset;
  let currentStartLine = section.startLine;
  for (const unit of units) {
    const unitText = text.slice(unit.start, unit.end);
    if (currentText.length > 0 && currentText.length + unitText.length > maxChunkSize) {
      chunks.push({
        text: currentText.trim(),
        heading: section.heading,
        startLine: currentStartLine,
        charOffset: currentOffset
      });
      currentText = unitText;
      currentOffset = section.charOffset + unit.start;
      currentStartLine = section.startLine + lineFromOffset(unit.start, starts);
    } else {
      currentText += unitText;
    }
  }
  if (currentText.trim().length > 0) {
    chunks.push({
      text: currentText.trim(),
      heading: section.heading,
      startLine: currentStartLine,
      charOffset: currentOffset
    });
  }
  return chunks;
}
function splitByParagraphsFallback(section, maxChunkSize) {
  const paragraphs = section.text.split(/\n\n+/);
  const chunks = [];
  let currentText = "";
  let currentOffset = section.charOffset;
  let currentStartLine = section.startLine;
  for (const para of paragraphs) {
    if (currentText.length > 0 && currentText.length + para.length + 2 > maxChunkSize) {
      chunks.push({
        text: currentText.trim(),
        heading: section.heading,
        startLine: currentStartLine,
        charOffset: currentOffset
      });
      currentOffset = currentOffset + currentText.length + 2;
      currentStartLine += currentText.split("\n").length + 1;
      currentText = para;
    } else {
      currentText = currentText ? currentText + "\n\n" + para : para;
    }
  }
  if (currentText.trim().length > 0) {
    chunks.push({
      text: currentText.trim(),
      heading: section.heading,
      startLine: currentStartLine,
      charOffset: currentOffset
    });
  }
  return chunks;
}
function hardSplit(chunk, maxSize, overlap) {
  const { text, heading, startLine, charOffset } = chunk;
  const chunks = [];
  let pos = 0;
  while (pos < text.length) {
    const end = Math.min(pos + maxSize, text.length);
    chunks.push({
      text: text.slice(pos, end),
      heading,
      startLine: startLine + text.slice(0, pos).split("\n").length - 1,
      charOffset: charOffset + pos
    });
    pos = end - (end < text.length ? overlap : 0);
    if (pos <= chunks[chunks.length - 1].charOffset - charOffset) {
      pos = end;
    }
  }
  return chunks;
}
function mergeTiny(chunks, minSize, maxSize) {
  if (chunks.length <= 1) return chunks;
  const merged = [chunks[0]];
  for (let i = 1; i < chunks.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = chunks[i];
    if (curr.text.length < minSize && prev.text.length + curr.text.length + 2 <= maxSize) {
      prev.text = prev.text + "\n\n" + curr.text;
    } else if (prev.text.length < minSize && prev.text.length + curr.text.length + 2 <= maxSize) {
      prev.text = prev.text + "\n\n" + curr.text;
      prev.heading = curr.heading;
    } else {
      merged.push(curr);
    }
  }
  return merged;
}

// src/index-store.ts
var INDEX_VERSION = 3;
var MAX_EXCERPT_LENGTH = 3500;
var KnowledgeIndex = class {
  config;
  embedder;
  data;
  dirty = false;
  saveTimer = null;
  constructor(config2, embedder2) {
    this.config = config2;
    this.embedder = embedder2;
    this.data = {
      version: INDEX_VERSION,
      dimensions: config2.dimensions,
      entries: {}
    };
  }
  size() {
    const paths = /* @__PURE__ */ new Set();
    for (const entry of Object.values(this.data.entries)) {
      paths.add(`${entry.sourceDir}/${entry.relPath}`);
    }
    return paths.size;
  }
  chunkCount() {
    return Object.keys(this.data.entries).length;
  }
  loadSync() {
    const indexFile = path2.join(this.config.indexDir, "index.json");
    if (fs2.existsSync(indexFile)) {
      try {
        const raw = fs2.readFileSync(indexFile, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed.version === INDEX_VERSION && parsed.dimensions === this.config.dimensions) {
          this.data = parsed;
        }
      } catch {
      }
    }
  }
  async load() {
    this.loadSync();
  }
  save() {
    fs2.mkdirSync(this.config.indexDir, { recursive: true });
    const indexFile = path2.join(this.config.indexDir, "index.json");
    fs2.writeFileSync(indexFile, JSON.stringify(this.data));
    this.dirty = false;
  }
  scheduleSave() {
    if (this.saveTimer) return;
    this.dirty = true;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.dirty) this.save();
    }, 5e3);
  }
  /**
   * Build the entry key for a file chunk.
   */
  entryKey(absPath, chunkIndex) {
    return `${absPath}#${chunkIndex}`;
  }
  /**
   * Get the absolute path from an entry key (strip #chunkIndex).
   */
  absPathFromKey(key) {
    const hashIdx = key.lastIndexOf("#");
    return hashIdx >= 0 ? key.slice(0, hashIdx) : key;
  }
  /**
   * Remove all chunks for a given absolute file path.
   */
  removeAllChunks(absPath) {
    const prefix = absPath + "#";
    const toRemove = [];
    for (const key of Object.keys(this.data.entries)) {
      if (key.startsWith(prefix)) {
        toRemove.push(key);
      }
    }
    for (const key of toRemove) {
      delete this.data.entries[key];
    }
    return toRemove.length;
  }
  /**
   * Prepare embedding text for a chunk with title context.
   */
  chunkEmbedText(relPath, heading, chunkText) {
    const title = relPath.replace(/\.[^.]+$/, "").replace(/\//g, " > ");
    const sectionContext = heading && heading !== "intro" ? ` > ${heading}` : "";
    return `Title: ${title}${sectionContext}

${chunkText}`;
  }
  /**
   * Scan all configured directories, find new/changed/removed files, update index.
   */
  async sync() {
    const allFiles = this.scanAllFiles();
    const currentPaths = new Set(allFiles.map((f) => f.absPath));
    let removed = 0;
    const seenRemoved = /* @__PURE__ */ new Set();
    for (const key of Object.keys(this.data.entries)) {
      const absPath = this.absPathFromKey(key);
      if (!currentPaths.has(absPath) && !seenRemoved.has(absPath)) {
        seenRemoved.add(absPath);
        removed += 1;
        this.removeAllChunks(absPath);
      }
    }
    const toProcess = [];
    for (const file of allFiles) {
      const existingKey = this.entryKey(file.absPath, 0);
      const existing = this.data.entries[existingKey];
      if (existing && existing.mtime >= file.mtime) continue;
      const content = this.readFileContent(file.absPath);
      if (!content || content.trim().length <= 20) continue;
      const chunks = chunkMarkdown(content);
      if (chunks.length === 0) continue;
      toProcess.push({ ...file, content, chunks });
    }
    let added = 0;
    let updated = 0;
    if (toProcess.length > 0) {
      const allChunkTexts = [];
      const chunkMeta = [];
      for (let fi = 0; fi < toProcess.length; fi++) {
        const file = toProcess[fi];
        for (let ci = 0; ci < file.chunks.length; ci++) {
          const chunk = file.chunks[ci];
          allChunkTexts.push(this.chunkEmbedText(file.relPath, chunk.heading, chunk.text));
          chunkMeta.push({ fileIdx: fi, chunkIdx: ci });
        }
      }
      const BATCH_SIZE = 50;
      const allVectors = new Array(allChunkTexts.length).fill(null);
      for (let i = 0; i < allChunkTexts.length; i += BATCH_SIZE) {
        const batchTexts = allChunkTexts.slice(i, i + BATCH_SIZE);
        const vectors = await this.embedder.embedBatch(batchTexts);
        for (let j = 0; j < vectors.length; j++) {
          allVectors[i + j] = vectors[j];
        }
      }
      const processedFiles = /* @__PURE__ */ new Set();
      for (let i = 0; i < chunkMeta.length; i++) {
        const { fileIdx, chunkIdx } = chunkMeta[i];
        const vector = allVectors[i];
        if (!vector) continue;
        const file = toProcess[fileIdx];
        if (!processedFiles.has(fileIdx)) {
          processedFiles.add(fileIdx);
          const hadExisting = this.removeAllChunks(file.absPath) > 0;
          if (hadExisting) updated++;
          else added++;
        }
        const chunk = file.chunks[chunkIdx];
        const key = this.entryKey(file.absPath, chunkIdx);
        this.data.entries[key] = {
          relPath: file.relPath,
          sourceDir: file.sourceDir,
          mtime: file.mtime,
          vector,
          excerpt: chunk.text.slice(0, MAX_EXCERPT_LENGTH),
          heading: chunk.heading,
          chunkIndex: chunkIdx
        };
      }
    }
    if (added + updated + removed > 0) {
      this.save();
    }
    return { added, updated, removed };
  }
  async rebuild() {
    this.data.entries = {};
    await this.sync();
  }
  async search(query, limit, signal) {
    const queryVector = await this.embedder.embed(query, signal);
    const scored = [];
    for (const [key, entry] of Object.entries(this.data.entries)) {
      if (!entry.vector) continue;
      const score = dotProduct(queryVector, entry.vector);
      scored.push({ key, absPath: this.absPathFromKey(key), score });
    }
    scored.sort((a, b) => b.score - a.score);
    const seenPaths = /* @__PURE__ */ new Set();
    const deduped = [];
    for (const item of scored) {
      if (seenPaths.has(item.absPath)) continue;
      seenPaths.add(item.absPath);
      deduped.push(item);
      if (deduped.length >= limit) break;
    }
    return deduped.filter((s) => s.score > 0.15).map((s) => {
      const entry = this.data.entries[s.key];
      return {
        path: s.absPath,
        score: s.score,
        excerpt: entry.excerpt,
        heading: entry.heading
      };
    });
  }
  /**
   * Update a single file in the index (called by watcher).
   */
  async updateFile(absPath, sourceDir) {
    if (!fs2.existsSync(absPath)) {
      this.removeFile(absPath);
      return;
    }
    const relPath = path2.relative(sourceDir, absPath);
    if (this.shouldSkip(relPath, path2.basename(absPath))) return;
    const stat = fs2.statSync(absPath);
    const content = this.readFileContent(absPath);
    if (!content || content.trim().length <= 20) {
      this.removeFile(absPath);
      return;
    }
    const chunks = chunkMarkdown(content);
    if (chunks.length === 0) {
      this.removeFile(absPath);
      return;
    }
    this.removeAllChunks(absPath);
    const texts = chunks.map((c) => this.chunkEmbedText(relPath, c.heading, c.text));
    const vectors = await this.embedder.embedBatch(texts);
    for (let i = 0; i < chunks.length; i++) {
      const vector = vectors[i];
      if (!vector) continue;
      const key = this.entryKey(absPath, i);
      this.data.entries[key] = {
        relPath,
        sourceDir,
        mtime: stat.mtimeMs,
        vector,
        excerpt: chunks[i].text.slice(0, MAX_EXCERPT_LENGTH),
        heading: chunks[i].heading,
        chunkIndex: i
      };
    }
    this.scheduleSave();
  }
  removeFile(absPath) {
    const removed = this.removeAllChunks(absPath);
    if (removed > 0) {
      this.scheduleSave();
    }
  }
  /** Alias for removeFile — removes all data for a file path. */
  deleteFile(absPath) {
    this.removeFile(absPath);
  }
  /** Flush pending saves and release resources. */
  close() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) {
      this.save();
    }
  }
  // -----------------------------------------------------------------------
  // Scanning
  // -----------------------------------------------------------------------
  scanAllFiles() {
    const results = [];
    for (const dir of this.config.dirs) {
      this.walkDir(dir, dir, results);
    }
    return results;
  }
  walkDir(currentDir, sourceDir, results) {
    let entries;
    try {
      entries = fs2.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absPath = path2.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (this.config.excludeDirs.includes(entry.name) || entry.name.startsWith(".")) {
          continue;
        }
        this.walkDir(absPath, sourceDir, results);
      } else if (entry.isFile()) {
        const ext = path2.extname(entry.name);
        if (!this.config.fileExtensions.includes(ext)) continue;
        const relPath = path2.relative(sourceDir, absPath);
        if (this.shouldSkip(relPath, entry.name)) continue;
        try {
          const stat = fs2.statSync(absPath);
          results.push({ absPath, relPath, sourceDir, mtime: stat.mtimeMs });
        } catch {
        }
      }
    }
  }
  shouldSkip(relPath, _basename) {
    const parts = relPath.split(path2.sep);
    for (const part of parts) {
      if (this.config.excludeDirs.includes(part) || part.startsWith(".")) {
        return true;
      }
    }
    return false;
  }
  readFileContent(absPath) {
    try {
      const content = fs2.readFileSync(absPath, "utf-8");
      return content.replace(/^---\n[\s\S]*?\n---\n?/, "");
    } catch {
      return null;
    }
  }
};
function dotProduct(a, b) {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

// src/sync-worker.ts
process.on("uncaughtException", (err) => {
  process.stderr.write(`knowledge-search worker uncaught: ${err.message}
`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`knowledge-search worker unhandled rejection: ${reason}
`);
  process.exit(1);
});
var config = loadConfig();
if (!config || !config.provider) {
  process.exit(0);
}
var embedder = createEmbedder(config.provider, config.dimensions);
var index = new KnowledgeIndex(config, embedder);
index.loadSync();
index.sync().then(({ added, updated, removed }) => {
  const result = JSON.stringify({
    added,
    updated,
    removed,
    size: index.size(),
    chunks: index.chunkCount()
  });
  process.stdout.write(result);
  process.exit(0);
}).catch((err) => {
  process.stderr.write(err.message);
  process.exit(1);
});

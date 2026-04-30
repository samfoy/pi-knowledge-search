/**
 * Content-aware markdown chunking.
 *
 * Splits markdown files into semantically meaningful chunks based on headings,
 * paragraphs, and size limits. Each chunk carries its heading context so
 * embeddings and search results are meaningful in isolation.
 *
 * Uses `remark-parse` + `unified` so that:
 *  - fenced code blocks are never misread as headings;
 *  - setext-style headings (`Heading\n----`) are recognised;
 *  - splitting of oversized sections respects top-level AST block boundaries.
 *
 * Very large markdown files (>= LARGE_FILE_FAST_PATH_CHARS) fall back to a
 * linear regex + paragraph splitter to keep indexing throughput responsive.
 */
import remarkParse from "remark-parse";
import { unified } from "unified";

export interface Chunk {
  /** The chunk text content */
  text: string;
  /** The heading this chunk falls under ("intro" for content before first heading) */
  heading: string;
  /** Line number where this chunk starts (0-indexed) */
  startLine: number;
  /** Character offset in original content */
  charOffset: number;
}

interface Section {
  text: string;
  heading: string;
  startLine: number;
  charOffset: number;
}

interface OffsetRange {
  start: number;
  end: number;
}

const LARGE_FILE_FAST_PATH_CHARS = 120_000;

/**
 * Split markdown content into chunks by headings, with size limits.
 *
 * Strategy:
 * 1. Split on ## (or deeper) headings using the markdown AST.
 * 2. Each section becomes a chunk.
 * 3. If a section is > maxChunkSize, split along top-level block boundaries.
 * 4. If still too large, hard-split at maxChunkSize with overlap.
 * 5. Merge tiny chunks (< minChunkSize) with their neighbour.
 * 6. For files with no headings, the whole file is treated as one "intro" section.
 */
export function chunkMarkdown(content: string, maxChunkSize = 3000, minChunkSize = 200): Chunk[] {
  if (!content || content.trim().length === 0) return [];

  // Very large markdown files can spend a long time in full AST parsing.
  // Use a linear text splitter to keep queue throughput responsive.
  if (content.length >= LARGE_FILE_FAST_PATH_CHARS) {
    return chunkMarkdownFast(content, maxChunkSize, minChunkSize);
  }

  // Split into sections by level-2+ markdown headings using AST positions.
  const sections = splitByHeadings(content);

  if (sections.length === 0) return [];

  // If the whole file is small enough, return as single chunk.
  if (content.length <= maxChunkSize) {
    return [
      {
        text: content.trim(),
        heading: sections[0]?.heading ?? "intro",
        startLine: 0,
        charOffset: 0,
      },
    ];
  }

  // Process each section and split oversized ones with block-aware boundaries.
  let rawChunks: Chunk[] = [];

  for (const section of sections) {
    if (section.text.trim().length === 0) continue;

    if (section.text.length <= maxChunkSize) {
      rawChunks.push(section);
    } else {
      rawChunks.push(...splitByBlocks(section, maxChunkSize));
    }
  }

  // Hard-split any remaining oversized chunks.
  rawChunks = rawChunks.flatMap((chunk) =>
    chunk.text.length <= maxChunkSize ? [chunk] : hardSplit(chunk, maxChunkSize, 200)
  );

  // Merge tiny chunks with neighbours.
  return mergeTiny(rawChunks, minChunkSize, maxChunkSize);
}

/**
 * Fast chunking path for very large files.
 * Uses line-based heading detection and paragraph splitting, avoiding AST parse cost.
 * Trades off code-fence awareness for throughput on huge files.
 */
function chunkMarkdownFast(content: string, maxChunkSize: number, minChunkSize: number): Chunk[] {
  if (content.length <= maxChunkSize) {
    return [
      {
        text: content.trim(),
        heading: "intro",
        startLine: 0,
        charOffset: 0,
      },
    ];
  }

  const starts = lineStartOffsets(content);
  const headingRegex = /^##+\s+(.+)$/gm;
  const headingMatches: { start: number; startLine: number; heading: string }[] = [];

  for (const match of content.matchAll(headingRegex)) {
    const start = match.index ?? 0;
    headingMatches.push({
      start,
      startLine: lineFromOffset(start, starts),
      heading: (match[1] ?? "intro").trim() || "intro",
    });
  }

  const sections: Section[] = [];
  if (headingMatches.length === 0) {
    sections.push({ text: content, heading: "intro", startLine: 0, charOffset: 0 });
  } else {
    if (headingMatches[0].start > 0) {
      sections.push({
        text: content.slice(0, headingMatches[0].start),
        heading: "intro",
        startLine: 0,
        charOffset: 0,
      });
    }

    for (let i = 0; i < headingMatches.length; i++) {
      const start = headingMatches[i].start;
      const end = i + 1 < headingMatches.length ? headingMatches[i + 1].start : content.length;
      sections.push({
        text: content.slice(start, end),
        heading: headingMatches[i].heading,
        startLine: headingMatches[i].startLine,
        charOffset: start,
      });
    }
  }

  let rawChunks: Chunk[] = [];
  for (const section of sections) {
    if (section.text.trim().length === 0) continue;
    if (section.text.length <= maxChunkSize) {
      rawChunks.push(section);
      continue;
    }
    rawChunks.push(...splitByParagraphsFallback(section, maxChunkSize));
  }

  rawChunks = rawChunks.flatMap((chunk) =>
    chunk.text.length <= maxChunkSize ? [chunk] : hardSplit(chunk, maxChunkSize, 200)
  );

  return mergeTiny(rawChunks, minChunkSize, maxChunkSize);
}

/** Build line start offsets for fast offset/line conversion helpers. */
function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** Map a 1-based markdown line number to a 0-based character offset. */
function offsetFromLine(line: number | undefined, starts: number[]): number {
  if (!line || line <= 1) return 0;
  return starts[Math.min(line - 1, starts.length - 1)] ?? 0;
}

/** Map a 0-based character offset to a 0-based line number. */
function lineFromOffset(offset: number, starts: number[]): number {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (starts[mid] <= offset) low = mid + 1;
    else high = mid - 1;
  }
  return Math.max(0, low - 1);
}

/** Extract visible heading text from mdast inline nodes. */
function headingText(node: any): string {
  if (!node) return "";
  if (typeof node.value === "string") return node.value;
  if (!Array.isArray(node.children)) return "";
  return node.children.map((child: any) => headingText(child)).join("");
}

/** Split content into sections by level-2+ markdown headings. */
function splitByHeadings(content: string): Section[] {
  const tree = unified().use(remarkParse).parse(content) as any;
  const starts = lineStartOffsets(content);
  const headings = (tree.children ?? [])
    .filter((node: any) => node.type === "heading" && node.depth >= 2)
    .map((node: any) => {
      const line = node.position?.start?.line as number | undefined;
      const start = offsetFromLine(line, starts);
      return {
        start,
        startLine: lineFromOffset(start, starts),
        heading: headingText(node).trim() || "intro",
      };
    })
    .sort((a: any, b: any) => a.start - b.start);

  if (headings.length === 0) {
    return [{ text: content, heading: "intro", startLine: 0, charOffset: 0 }];
  }

  const sections: Section[] = [];
  if (headings[0].start > 0) {
    sections.push({
      text: content.slice(0, headings[0].start),
      heading: "intro",
      startLine: 0,
      charOffset: 0,
    });
  }

  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].start;
    const end = i + 1 < headings.length ? headings[i + 1].start : content.length;
    sections.push({
      text: content.slice(start, end),
      heading: headings[i].heading,
      startLine: headings[i].startLine,
      charOffset: start,
    });
  }

  return sections;
}

/**
 * Split an oversized section by top-level markdown blocks.
 * Falls back to paragraph boundaries if block positions are unavailable.
 */
function splitByBlocks(section: Section, maxChunkSize: number): Chunk[] {
  const text = section.text;
  const tree = unified().use(remarkParse).parse(text) as any;
  const starts = lineStartOffsets(text);

  const blocks: OffsetRange[] = (tree.children ?? [])
    .map((node: any) => {
      const startLine = node.position?.start?.line as number | undefined;
      const endLine = node.position?.end?.line as number | undefined;
      if (!startLine || !endLine) return null;
      return {
        start: offsetFromLine(startLine, starts),
        end: offsetFromLine(endLine + 1, starts),
      };
    })
    .filter((x: OffsetRange | null): x is OffsetRange => Boolean(x))
    .sort((a: OffsetRange, b: OffsetRange) => a.start - b.start);

  if (blocks.length === 0) {
    return splitByParagraphsFallback(section, maxChunkSize);
  }

  // Adjust first block to start at 0 so leading whitespace/content isn't dropped,
  // and stretch each block to cover through the next block's start.
  const units: OffsetRange[] = blocks.map((block, i) => ({
    start: i === 0 ? 0 : block.start,
    end: i + 1 < blocks.length ? blocks[i + 1].start : text.length,
  }));

  const chunks: Chunk[] = [];
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
        charOffset: currentOffset,
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
      charOffset: currentOffset,
    });
  }

  return chunks;
}

/** Fallback splitter for malformed markdown where block positions are unavailable. */
function splitByParagraphsFallback(section: Section, maxChunkSize: number): Chunk[] {
  const paragraphs = section.text.split(/\n\n+/);
  const chunks: Chunk[] = [];
  let currentText = "";
  let currentOffset = section.charOffset;
  let currentStartLine = section.startLine;

  for (const para of paragraphs) {
    if (currentText.length > 0 && currentText.length + para.length + 2 > maxChunkSize) {
      chunks.push({
        text: currentText.trim(),
        heading: section.heading,
        startLine: currentStartLine,
        charOffset: currentOffset,
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
      charOffset: currentOffset,
    });
  }

  return chunks;
}

/** Hard-split an oversized chunk at maxSize with overlap. */
function hardSplit(chunk: Chunk, maxSize: number, overlap: number): Chunk[] {
  const { text, heading, startLine, charOffset } = chunk;
  const chunks: Chunk[] = [];
  let pos = 0;

  while (pos < text.length) {
    const end = Math.min(pos + maxSize, text.length);
    chunks.push({
      text: text.slice(pos, end),
      heading,
      startLine: startLine + text.slice(0, pos).split("\n").length - 1,
      charOffset: charOffset + pos,
    });
    pos = end - (end < text.length ? overlap : 0);
    // Prevent infinite loop if overlap >= maxSize
    if (pos <= chunks[chunks.length - 1].charOffset - charOffset) {
      pos = end;
    }
  }

  return chunks;
}

/** Merge chunks smaller than minSize with their neighbor. */
function mergeTiny(chunks: Chunk[], minSize: number, maxSize: number): Chunk[] {
  if (chunks.length <= 1) return chunks;

  const merged: Chunk[] = [chunks[0]];

  for (let i = 1; i < chunks.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = chunks[i];

    // Merge if current is tiny and combined size fits
    if (curr.text.length < minSize && prev.text.length + curr.text.length + 2 <= maxSize) {
      prev.text = prev.text + "\n\n" + curr.text;
    } else if (prev.text.length < minSize && prev.text.length + curr.text.length + 2 <= maxSize) {
      prev.text = prev.text + "\n\n" + curr.text;
      prev.heading = curr.heading; // adopt the bigger chunk's heading
    } else {
      merged.push(curr);
    }
  }

  return merged;
}

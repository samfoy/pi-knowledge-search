/**
 * Content-aware markdown chunking.
 *
 * Splits markdown files into semantically meaningful chunks based on headings,
 * paragraphs, and size limits. Each chunk carries its heading context so
 * embeddings and search results are meaningful in isolation.
 */

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

const HEADING_RE = /^(#{2,6})\s+(.+)$/;

/**
 * Split markdown content into chunks by headings, with size limits.
 *
 * Strategy:
 * 1. Split on ## headings (level 2+)
 * 2. Each section becomes a chunk
 * 3. If a section is > maxChunkSize, split on paragraphs (double newline)
 * 4. If still too large, hard-split at maxChunkSize with overlap
 * 5. Merge tiny chunks (< minChunkSize) with their neighbor
 * 6. For files with no headings, split on paragraphs
 * 7. Each chunk gets the file's title (first # heading or filename) prepended for context
 */
export function chunkMarkdown(content: string, maxChunkSize = 3000, minChunkSize = 200): Chunk[] {
  if (!content || content.trim().length === 0) return [];

  // Split into sections by ## headings
  const sections = splitByHeadings(content);

  if (sections.length === 0) return [];

  // If the whole file is small enough, return as single chunk
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

  // Process each section — split large ones, collect all chunks
  let rawChunks: Chunk[] = [];

  for (const section of sections) {
    if (section.text.trim().length === 0) continue;

    if (section.text.length <= maxChunkSize) {
      rawChunks.push(section);
    } else {
      // Split large section by paragraphs
      const subChunks = splitByParagraphs(
        section.text,
        section.heading,
        section.startLine,
        section.charOffset,
        maxChunkSize
      );
      rawChunks.push(...subChunks);
    }
  }

  // Hard-split any remaining oversized chunks
  rawChunks = rawChunks.flatMap((chunk) => {
    if (chunk.text.length <= maxChunkSize) return [chunk];
    return hardSplit(chunk, maxChunkSize, 200);
  });

  // Merge tiny chunks with neighbors
  rawChunks = mergeTiny(rawChunks, minChunkSize, maxChunkSize);

  return rawChunks;
}

interface Section {
  text: string;
  heading: string;
  startLine: number;
  charOffset: number;
}

/** Split content into sections by level-2+ headings. */
function splitByHeadings(content: string): Section[] {
  const lines = content.split("\n");
  const sections: Section[] = [];
  let currentHeading = "intro";
  let currentLines: string[] = [];
  let sectionStartLine = 0;
  let sectionCharOffset = 0;
  let charPos = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(HEADING_RE);

    if (match) {
      // Flush previous section
      if (currentLines.length > 0) {
        sections.push({
          text: currentLines.join("\n"),
          heading: currentHeading,
          startLine: sectionStartLine,
          charOffset: sectionCharOffset,
        });
      }
      currentHeading = match[2].trim();
      currentLines = [line];
      sectionStartLine = i;
      sectionCharOffset = charPos;
    } else {
      currentLines.push(line);
    }
    charPos += line.length + 1; // +1 for newline
  }

  // Flush last section
  if (currentLines.length > 0) {
    sections.push({
      text: currentLines.join("\n"),
      heading: currentHeading,
      startLine: sectionStartLine,
      charOffset: sectionCharOffset,
    });
  }

  return sections;
}

/** Split a section's text by double-newline paragraphs, respecting maxChunkSize. */
function splitByParagraphs(
  text: string,
  heading: string,
  startLine: number,
  charOffset: number,
  maxChunkSize: number
): Chunk[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: Chunk[] = [];
  let currentText = "";
  let currentOffset = charOffset;
  let currentStartLine = startLine;

  for (const para of paragraphs) {
    if (currentText.length > 0 && currentText.length + para.length + 2 > maxChunkSize) {
      // Flush current accumulation
      chunks.push({
        text: currentText.trim(),
        heading,
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
      heading,
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

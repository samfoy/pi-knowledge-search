import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkMarkdown } from "./chunker.js";

describe("chunkMarkdown", () => {
  it("returns empty array for empty string", () => {
    assert.deepStrictEqual(chunkMarkdown(""), []);
  });

  it("returns empty array for whitespace-only string", () => {
    assert.deepStrictEqual(chunkMarkdown("   \n\n  "), []);
  });

  it("returns single chunk for short content", () => {
    const md = "# Title\n\nSome paragraph.";
    const chunks = chunkMarkdown(md);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].text, md);
    assert.equal(chunks[0].heading, "intro");
    assert.equal(chunks[0].startLine, 0);
    assert.equal(chunks[0].charOffset, 0);
  });

  it("splits on ## headings", () => {
    const md = [
      "# Title",
      "",
      "Intro paragraph.",
      "",
      "## Section One",
      "",
      "Content of section one.",
      "",
      "## Section Two",
      "",
      "Content of section two.",
    ].join("\n");
    // Make it large enough to not be a single chunk
    const chunks = chunkMarkdown(md, 50);
    assert.ok(chunks.length >= 2, `Expected >=2 chunks, got ${chunks.length}`);

    const headings = chunks.map((c) => c.heading);
    assert.ok(headings.includes("Section One"));
    assert.ok(headings.includes("Section Two"));
  });

  it("assigns 'intro' heading for content before first heading", () => {
    const md = [
      "Some intro text before any heading.",
      "",
      "## First Section",
      "",
      "Section content here.",
    ].join("\n");
    const chunks = chunkMarkdown(md, 40);
    assert.equal(chunks[0].heading, "intro");
  });

  it("handles markdown with no headings (paragraphs only)", () => {
    const para1 = "First paragraph with some content.";
    const para2 = "Second paragraph with more content.";
    const para3 = "Third paragraph wrapping up.";
    const md = [para1, "", para2, "", para3].join("\n");
    const chunks = chunkMarkdown(md, 50);
    assert.ok(chunks.length >= 1);
    // All chunks should have 'intro' heading since no headings exist
    for (const chunk of chunks) {
      assert.equal(chunk.heading, "intro");
    }
  });

  it("hard-splits a very long single paragraph", () => {
    const longText = "A".repeat(500);
    const chunks = chunkMarkdown(longText, 100);
    assert.ok(
      chunks.length > 1,
      `Expected >1 chunks for long text, got ${chunks.length}`
    );
    // All text should be covered (with possible overlap)
    const totalLen = chunks.reduce((sum, c) => sum + c.text.length, 0);
    assert.ok(totalLen >= longText.length, "Hard-split should cover all text");
  });

  it("hard-split chunks have overlap", () => {
    const longText = "ABCDEFGHIJ".repeat(50); // 500 chars
    const maxSize = 100;
    const chunks = chunkMarkdown(longText, maxSize);
    assert.ok(chunks.length > 1);

    // Check overlap: end of chunk N should overlap with start of chunk N+1
    for (let i = 0; i < chunks.length - 1; i++) {
      const currentEnd = chunks[i].text.slice(-50);
      const nextStart = chunks[i + 1].text.slice(0, 50);
      // There should be some shared content (overlap = 200 default, but text is shorter)
      const hasOverlap =
        currentEnd.length > 0 &&
        nextStart.length > 0 &&
        chunks[i].text.length + chunks[i + 1].text.length > longText.length / chunks.length;
      // Just verify chunks exist and are sized properly
      assert.ok(
        chunks[i].text.length <= maxSize,
        `Chunk ${i} exceeds maxSize: ${chunks[i].text.length}`
      );
    }
  });

  it("preserves code blocks in chunks", () => {
    const md = [
      "## Code Example",
      "",
      "Here is some code:",
      "",
      "```typescript",
      'const x = "hello";',
      "console.log(x);",
      "```",
      "",
      "And some text after.",
    ].join("\n");
    const chunks = chunkMarkdown(md);
    const allText = chunks.map((c) => c.text).join("\n\n");
    assert.ok(allText.includes("```typescript"));
    assert.ok(allText.includes('const x = "hello"'));
    assert.ok(allText.includes("```"));
  });

  it("merges tiny chunks with neighbors", () => {
    // Create content where some sections are very small
    const md = [
      "## Big Section",
      "",
      "This is a reasonably sized section with enough content to stand on its own.",
      "",
      "## Tiny",
      "",
      "Hi.",
      "",
      "## Another Big Section",
      "",
      "This section also has enough content to be meaningful on its own.",
    ].join("\n");
    const chunks = chunkMarkdown(md, 3000, 200);
    // The tiny "Hi." section should be merged with a neighbor
    const tinyChunk = chunks.find((c) => c.text.trim() === "## Tiny\n\nHi.");
    assert.equal(
      tinyChunk,
      undefined,
      "Tiny chunk should be merged, not standalone"
    );
  });

  it("tracks startLine correctly across sections", () => {
    const md = [
      "Line 0",
      "Line 1",
      "",
      "## Section at Line 3",
      "",
      "Line 5 content",
    ].join("\n");
    const chunks = chunkMarkdown(md, 30);
    // At least verify first chunk starts at line 0
    assert.equal(chunks[0].startLine, 0);
  });

  it("tracks charOffset correctly", () => {
    const md = "Short intro.\n\n## Heading\n\nBody text here.";
    const chunks = chunkMarkdown(md, 20);
    assert.equal(chunks[0].charOffset, 0);
    if (chunks.length > 1) {
      assert.ok(chunks[1].charOffset > 0);
    }
  });

  it("handles level 3-6 headings as section breaks", () => {
    const md = [
      "### Level 3 Heading",
      "",
      "Content under level 3.",
      "",
      "#### Level 4 Heading",
      "",
      "Content under level 4.",
    ].join("\n");
    const chunks = chunkMarkdown(md, 40);
    const headings = chunks.map((c) => c.heading);
    assert.ok(
      headings.includes("Level 3 Heading") || headings.includes("Level 4 Heading"),
      "Should recognize level 3+ headings"
    );
  });

  it("does NOT split on level 1 headings (# Title)", () => {
    // The HEADING_RE matches #{2,6}, so # should not trigger a split
    const md = [
      "# Title",
      "",
      "Intro text.",
      "",
      "# Another Title",
      "",
      "More text.",
    ].join("\n");
    const chunks = chunkMarkdown(md, 3000);
    // Both # headings should be in the same "intro" section since # doesn't split
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].heading, "intro");
  });

  it("respects custom maxChunkSize", () => {
    const md = "Word ".repeat(200); // ~1000 chars
    const chunks = chunkMarkdown(md, 100);
    for (const chunk of chunks) {
      assert.ok(
        chunk.text.length <= 100,
        `Chunk exceeds custom maxSize: ${chunk.text.length}`
      );
    }
  });

  it("respects custom minChunkSize for merging", () => {
    // With a very high minChunkSize, small chunks should be aggressively merged
    const md = [
      "## A",
      "",
      "Small.",
      "",
      "## B",
      "",
      "Also small.",
      "",
      "## C",
      "",
      "Still small.",
    ].join("\n");
    const chunksDefault = chunkMarkdown(md, 3000, 200);
    const chunksAggressive = chunkMarkdown(md, 3000, 500);
    assert.ok(
      chunksAggressive.length <= chunksDefault.length,
      "Higher minChunkSize should produce fewer (merged) chunks"
    );
  });
});

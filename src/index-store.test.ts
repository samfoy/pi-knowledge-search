import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dotProduct } from "./index-store.js";

describe("dotProduct", () => {
  it("returns 0 for orthogonal vectors", () => {
    assert.equal(dotProduct([1, 0, 0], [0, 1, 0]), 0);
  });

  it("returns 1 for identical unit vectors", () => {
    const v = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)];
    const result = dotProduct(v, v);
    assert.ok(Math.abs(result - 1.0) < 1e-10, `Expected ~1.0, got ${result}`);
  });

  it("returns -1 for opposite unit vectors", () => {
    const v1 = [1, 0, 0];
    const v2 = [-1, 0, 0];
    assert.equal(dotProduct(v1, v2), -1);
  });

  it("computes correct dot product", () => {
    assert.equal(dotProduct([1, 2, 3], [4, 5, 6]), 32); // 4+10+18
  });

  it("handles empty vectors", () => {
    assert.equal(dotProduct([], []), 0);
  });

  it("handles mismatched lengths (uses shorter)", () => {
    assert.equal(dotProduct([1, 2], [3, 4, 5]), 11); // 3+8
  });

  it("works with high-dimensional vectors", () => {
    const dim = 512;
    const a = new Array(dim).fill(1 / Math.sqrt(dim));
    const b = new Array(dim).fill(1 / Math.sqrt(dim));
    const result = dotProduct(a, b);
    assert.ok(
      Math.abs(result - 1.0) < 1e-10,
      `Expected ~1.0 for normalized vectors, got ${result}`
    );
  });
});

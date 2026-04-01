import { describe, test, expect } from "bun:test";
import {
  applyTransform,
  applyTransformChain,
} from "../../src/scraper/transforms.ts";

describe("Transform Pipeline", () => {
  test("regex extracts capture group", () => {
    const result = applyTransform("Library ID: 12345", {
      type: "regex",
      pattern: "Library ID[: ]+(\\d+)",
      group: 1,
    });
    expect(result).toBe("12345");
  });

  test("regex group 0 returns full match", () => {
    const result = applyTransform("Library ID: 12345", {
      type: "regex",
      pattern: "\\d+",
      group: 0,
    });
    expect(result).toBe("12345");
  });

  test("regex returns null on no match", () => {
    const result = applyTransform("No ID here", {
      type: "regex",
      pattern: "Library ID[: ]+(\\d+)",
      group: 1,
    });
    expect(result).toBeNull();
  });

  test("regex defaults to group 1 when group omitted", () => {
    const result = applyTransform("prefix-42-suffix", {
      type: "regex",
      pattern: "prefix-(\\d+)",
    });
    expect(result).toBe("42");
  });

  test("regex throws on invalid pattern", () => {
    expect(() =>
      applyTransform("input", { type: "regex", pattern: "[invalid" }),
    ).toThrow("Invalid regex pattern in transform");
  });

  test("replace performs string substitution on all occurrences", () => {
    const result = applyTransform("  hello  world  ", {
      type: "replace",
      find: "  ",
      replaceWith: "",
    });
    // replaceAll removes every "  " occurrence
    expect(result).toBe("helloworld");
  });

  test("replace on non-matching find returns input unchanged", () => {
    const result = applyTransform("hello world", {
      type: "replace",
      find: "xyz",
      replaceWith: "!",
    });
    expect(result).toBe("hello world");
  });

  test("exists returns true for non-empty string", () => {
    expect(applyTransform("Active", { type: "exists" })).toBe(true);
  });

  test("exists returns false for empty string", () => {
    expect(applyTransform("", { type: "exists" })).toBe(false);
  });

  test("chain applies transforms in order", () => {
    const result = applyTransformChain("Library ID: 12345 (active)", [
      { type: "regex", pattern: "Library ID[: ]+(\\d+)", group: 1 },
    ]);
    expect(result).toBe("12345");
  });

  test("chain with null intermediate short-circuits to null", () => {
    const result = applyTransformChain("No match", [
      { type: "regex", pattern: "Library ID[: ]+(\\d+)", group: 1 },
      { type: "replace", find: "x", replaceWith: "y" },
    ]);
    expect(result).toBeNull();
  });

  test("chain with empty transforms returns input as-is", () => {
    expect(applyTransformChain("untouched", [])).toBe("untouched");
  });

  test("chain casts intermediate numeric result to string for next step", () => {
    // regex returns a string capture; replace then operates on it
    const result = applyTransformChain("value-007", [
      { type: "regex", pattern: "value-(\\d+)", group: 1 },
      { type: "replace", find: "0", replaceWith: "" },
    ]);
    // "007" → replace all "0" → "7"
    expect(result).toBe("7");
  });
});

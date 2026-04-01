import { describe, test, expect } from "bun:test";
import { BrandGuardian } from "../../src/typst/brand-guardian.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BRAND_LIB = "@local/spell-brand";

/** Minimal valid content: correct import + only brand palette colors. */
function validContent(...extraLines: string[]): string {
  return [
    `#import "${BRAND_LIB}": *`,
    "#set text(fill: #7c3aed)",
    ...extraLines,
  ].join("\n");
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("BrandGuardian.checkStructural", () => {
  const guardian = new BrandGuardian();

  describe("import check", () => {
    test("content with correct double-quote import passes", () => {
      const result = guardian.checkStructural(
        `#import "${BRAND_LIB}": *\n#set text(fill: #1e1b4b)`,
        BRAND_LIB
      );
      expect(result.passed).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    test("content with correct single-quote import passes", () => {
      const result = guardian.checkStructural(
        `#import '${BRAND_LIB}': *\n#set text(fill: #1e1b4b)`,
        BRAND_LIB
      );
      expect(result.passed).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    test("content without import fails with descriptive message", () => {
      // No import statement at all — only a color usage.
      const result = guardian.checkStructural(
        "#set text(fill: #7c3aed)",
        BRAND_LIB
      );
      expect(result.passed).toBe(false);
      expect(result.issues.length).toBeGreaterThanOrEqual(1);
      // Issue must name the missing library so the author knows what to add.
      expect(result.issues.some((i) => i.includes(BRAND_LIB))).toBe(true);
    });

    test("import of a different lib is not treated as valid", () => {
      const result = guardian.checkStructural(
        `#import "other-lib": *\n#set text(fill: #7c3aed)`,
        BRAND_LIB
      );
      expect(result.passed).toBe(false);
      expect(result.issues.some((i) => i.includes(BRAND_LIB))).toBe(true);
    });
  });

  describe("off-brand color detection", () => {
    test("off-brand hex #FF0000 is detected and reported", () => {
      const result = guardian.checkStructural(
        validContent("#set page(fill: #FF0000)"),
        BRAND_LIB
      );
      expect(result.passed).toBe(false);
      // Must name the offending literal so author can locate it.
      expect(result.issues.some((i) => i.includes("#FF0000"))).toBe(true);
    });

    test("brand palette hex #7C3AED (uppercase) is NOT flagged", () => {
      const result = guardian.checkStructural(
        validContent("#set text(fill: #7C3AED)"),
        BRAND_LIB
      );
      expect(result.passed).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    test("shorthand hex #abc not in palette is expanded and flagged", () => {
      // #abc → #aabbcc, which is not a brand color.
      const result = guardian.checkStructural(
        validContent("#set text(fill: #abc)"),
        BRAND_LIB
      );
      expect(result.passed).toBe(false);
      expect(result.issues.some((i) => i.includes("#abc"))).toBe(true);
    });

    test("alpha hex #7C3AEDFF is stripped to #7c3aed and passes", () => {
      // #7c3aed is in the brand palette; alpha byte must be discarded before lookup.
      const result = guardian.checkStructural(
        validContent("#set text(fill: #7C3AEDFF)"),
        BRAND_LIB
      );
      expect(result.passed).toBe(true);
      expect(result.issues).toHaveLength(0);
    });
  });

  describe("issue accumulation", () => {
    test("missing import AND off-brand color both appear in issues", () => {
      // No import + an off-brand color: two distinct issues.
      const result = guardian.checkStructural(
        "#set page(fill: #FF0000)",
        BRAND_LIB
      );
      expect(result.passed).toBe(false);
      // At least two issues: one for the missing import, one for the color.
      expect(result.issues.length).toBeGreaterThanOrEqual(2);
      expect(result.issues.some((i) => i.includes(BRAND_LIB))).toBe(true);
      expect(result.issues.some((i) => i.includes("#FF0000"))).toBe(true);
    });

    test("multiple off-brand colors each produce a separate issue", () => {
      const result = guardian.checkStructural(
        validContent(
          "#set page(fill: #FF0000)",
          "#set text(fill: #00FF00)"
        ),
        BRAND_LIB
      );
      expect(result.passed).toBe(false);
      const colorIssues = result.issues.filter((i) => i.includes("Off-brand"));
      expect(colorIssues.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("clean document", () => {
    test("correct import with only brand palette colors passes with no issues", () => {
      const content = [
        `#import "${BRAND_LIB}": *`,
        "#set text(fill: #7c3aed)",
        "#set page(fill: #f5f3ff)",
        "#let accent = #1e1b4b",
        "#let muted = #9ca3af",
      ].join("\n");

      const result = guardian.checkStructural(content, BRAND_LIB);
      expect(result.passed).toBe(true);
      expect(result.issues).toHaveLength(0);
    });
  });
});

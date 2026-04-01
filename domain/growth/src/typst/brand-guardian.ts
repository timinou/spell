import type { TypstCompiler } from "./wasm-compiler";

export interface BrandCheckResult {
  passed: boolean;
  issues: string[];
}

/**
 * Spell brand color palette.
 * All values are lowercase. Matching is case-insensitive.
 */
const BRAND_PALETTE = new Set([
  // Core
  "#7c3aed", // Spell purple
  "#1e1b4b", // Dark
  "#f5f3ff", // Light
  // Grays
  "#f9fafb",
  "#f3f4f6",
  "#e5e7eb",
  "#d1d5db",
  "#9ca3af",
  "#6b7280",
  "#4b5563",
  "#374151",
  "#1f2937",
  "#111827",
]);

/** Normalize a hex color to lowercase 7-char form (#rrggbb). */
function normalizeHex(hex: string): string {
  const h = hex.toLowerCase();
  // Expand shorthand (#abc → #aabbcc)
  if (h.length === 4) {
    return "#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  }
  // Strip alpha channel (#rrggbbaa → #rrggbb)
  if (h.length === 9) return h.slice(0, 7);
  return h;
}

export class BrandGuardian {
  /**
   * Structural check — runs without compiling.
   *
   * 1. Verifies the content imports `brandLib`.
   * 2. Scans for hex color literals not present in the brand palette.
   */
  checkStructural(typContent: string, brandLib: string): BrandCheckResult {
    const issues: string[] = [];

    // Check for import of the brand library.
    // Accepts: #import "brand.typ" or #import "@local/brand" etc.
    const importPattern = new RegExp(
      `#import\\s+["']${escapeRegex(brandLib)}["']`
    );
    if (!importPattern.test(typContent)) {
      issues.push(`Content does not import brand library: ${brandLib}`);
    }

    // Find all hex color literals: #rrggbb, #rgb, #rrggbbaa
    const hexRe = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{1}(?:[0-9a-fA-F]{2}(?:[0-9a-fA-F]{2})?)?)?(?![0-9a-fA-F])/g;
    let m: RegExpExecArray | null;

    while ((m = hexRe.exec(typContent)) !== null) {
      const raw = m[0];
      // Skip very short matches that are just CSS id selectors, not colors.
      if (raw.length < 4) continue;

      const normalized = normalizeHex(raw);
      if (!BRAND_PALETTE.has(normalized)) {
        issues.push(`Off-brand color literal: ${raw} (normalized: ${normalized})`);
      }
    }

    return { passed: issues.length === 0, issues };
  }

  /**
   * Compilation check — compiles via the WASM compiler and reports errors.
   * Does not load fonts or additional sources; caller is responsible for that.
   */
  async checkCompile(
    compiler: TypstCompiler,
    mainPath: string
  ): Promise<BrandCheckResult> {
    const result = await compiler.compile(mainPath);
    const issues = result.errors.map((e) => {
      const loc =
        e.line !== undefined
          ? ` (line ${e.line}${e.column !== undefined ? `:${e.column}` : ""})`
          : "";
      return `Compile error${loc}: ${e.message}`;
    });

    return { passed: issues.length === 0, issues };
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

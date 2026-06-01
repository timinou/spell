/**
 * ANSI-aware text utilities powered by native bindings.
 */
import { Ellipsis, type ExtractSegmentsResult, type SliceWithWidthResult } from "@spell/pi-natives";
export type { ExtractSegmentsResult, SliceWithWidthResult } from "./types";
export { Ellipsis } from "./types";
/**
 * Truncate text to fit within a maximum visible width, adding ellipsis if needed.
 * Optionally pad with spaces to reach exactly maxWidth.
 * Properly handles ANSI escape codes (they don't count toward width).
 *
 * @param text - Text to truncate (may contain ANSI codes)
 * @param maxWidth - Maximum visible width
 * @param ellipsis - Ellipsis kind to append when truncating (default: Unicode "…")
 * @param pad - If true, pad result with spaces to exactly maxWidth (default: false)
 * @returns Truncated text, optionally padded to exactly maxWidth
 */
export declare function truncateToWidth(text: string, maxWidth: number, ellipsis?: Ellipsis, pad?: boolean, tabWidth?: number): string;
/**
 * Slice a range of visible columns from a line.
 * @param line - The line to slice
 * @param startCol - The starting column
 * @param length - The length of the slice
 * @param strict - Whether to strictly enforce the length
 * @returns The sliced line
 */
export declare function sliceWithWidth(line: string, startCol: number, length: number, strict?: boolean, tabWidth?: number): SliceWithWidthResult;
/**
 * Wrap text to a visible width while preserving ANSI color/style sequences.
 *
 * @param text - Input text, optionally containing ANSI escape codes
 * @param width - Maximum visible width per output line
 * @param tabWidth - Width used when measuring tab characters (default: configured tab width)
 * @returns Wrapped lines with ANSI state preserved across breaks
 */
export declare function wrapTextWithAnsi(text: string, width: number, tabWidth?: number): string[];
/**
 * Measure visible terminal width of text, excluding ANSI escape sequences.
 *
 * @param text - Input text, optionally containing ANSI escape codes
 * @param tabWidth - Width used when measuring tab characters (default: configured tab width)
 * @returns Visible width in terminal cells
 */
export declare function visibleWidth(text: string, tabWidth?: number): number;
/**
 * Extract before/after segments around an overlay range using visible-column boundaries.
 *
 * @param line - Input line, optionally containing ANSI escape codes
 * @param beforeEnd - Visible column where the `before` segment ends
 * @param afterStart - Visible column where the `after` segment starts
 * @param afterLen - Visible width to include in the `after` segment
 * @param strictAfter - When true, graphemes that overflow `afterLen` are dropped
 * @param tabWidth - Width used when measuring tab characters (default: configured tab width)
 * @returns Visible-width-aware before/after segments
 */
export declare function extractSegments(line: string, beforeEnd: number, afterStart: number, afterLen: number, strictAfter: boolean, tabWidth?: number): ExtractSegmentsResult;
export declare const sanitizeText: (text: string) => string;
//# sourceMappingURL=index.d.ts.map
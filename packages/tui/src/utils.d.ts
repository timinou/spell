export { Ellipsis, extractSegments, sliceWithWidth, truncateToWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-natives";
export declare function replaceTabs(text: string): string;
/**
 * Returns a string of n spaces. Uses a pre-allocated buffer for efficiency.
 */
export declare function padding(n: number): string;
/**
 * Get the shared grapheme segmenter instance.
 */
export declare function getSegmenter(): Intl.Segmenter;
/**
 * Calculate the visible width of a string in terminal columns.
 */
export declare function visibleWidthRaw(str: string): number;
/**
 * Calculate the visible width of a string in terminal columns.
 */
export declare function visibleWidth(str: string): number;
/**
 * Check if a character is whitespace.
 */
export declare function isWhitespaceChar(char: string): boolean;
/**
 * Check if a character is punctuation.
 */
export declare function isPunctuationChar(char: string): boolean;
export type WordNavKind = "whitespace" | "delimiter" | "cjk" | "word" | "other";
/**
 * Coarse Unicode-aware character classification for word navigation (Option/Alt + Left/Right).
 * This intentionally avoids language-specific word segmentation for predictability across scripts.
 */
export declare function getWordNavKind(grapheme: string): WordNavKind;
export declare function isWordNavJoiner(grapheme: string): boolean;
/**
 * Move the cursor one "word" to the left using Unicode-aware coarse navigation.
 *
 * Returns a new cursor index in the range [0, text.length].
 */
export declare function moveWordLeft(text: string, cursor: number): number;
/**
 * Move the cursor one "word" to the right using Unicode-aware coarse navigation.
 *
 * Returns a new cursor index in the range [0, text.length].
 */
export declare function moveWordRight(text: string, cursor: number): number;
/**
 * Apply background color to a line, padding to full width.
 *
 * @param line - Line of text (may contain ANSI codes)
 * @param width - Total width to pad to
 * @param bgFn - Background color function
 * @returns Line with background applied and padded to width
 */
export declare function applyBackgroundToLine(line: string, width: number, bgFn: (text: string) => string): string;
/**
 * Extract a range of visible columns from a line. Handles ANSI codes and wide chars.
 *
 * @param strict - If true, exclude wide chars at boundary that would extend past the range
 */
export declare function sliceByColumn(line: string, startCol: number, length: number, strict?: boolean): string;
//# sourceMappingURL=utils.d.ts.map
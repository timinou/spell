/**
 * ANSI-aware text utilities powered by native bindings.
 */

import { Ellipsis, type ExtractSegmentsResult, type SliceWithWidthResult } from "@spell/pi-natives";
import { getDefaultTabWidth } from "@spell/pi-utils";
import { native } from "../native";

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
export function truncateToWidth(
	text: string,
	maxWidth: number,
	ellipsis: Ellipsis = Ellipsis.Unicode,
	pad = false,
	tabWidth = getDefaultTabWidth(),
): string {
	return native.truncateToWidth(text, maxWidth, ellipsis, pad, tabWidth);
}

/**
 * Slice a range of visible columns from a line.
 * @param line - The line to slice
 * @param startCol - The starting column
 * @param length - The length of the slice
 * @param strict - Whether to strictly enforce the length
 * @returns The sliced line
 */
export function sliceWithWidth(
	line: string,
	startCol: number,
	length: number,
	strict = false,
	tabWidth = getDefaultTabWidth(),
): SliceWithWidthResult {
	if (length <= 0) return { text: "", width: 0 };
	return native.sliceWithWidth(line, startCol, length, strict, tabWidth);
}

/**
 * Wrap text to a visible width while preserving ANSI color/style sequences.
 *
 * @param text - Input text, optionally containing ANSI escape codes
 * @param width - Maximum visible width per output line
 * @param tabWidth - Width used when measuring tab characters (default: configured tab width)
 * @returns Wrapped lines with ANSI state preserved across breaks
 */
export function wrapTextWithAnsi(text: string, width: number, tabWidth = getDefaultTabWidth()): string[] {
	return native.wrapTextWithAnsi(sanitizeWrapInput(text), width, tabWidth);
}

/**
 * Measure visible terminal width of text, excluding ANSI escape sequences.
 *
 * @param text - Input text, optionally containing ANSI escape codes
 * @param tabWidth - Width used when measuring tab characters (default: configured tab width)
 * @returns Visible width in terminal cells
 */
export function visibleWidth(text: string, tabWidth = getDefaultTabWidth()): number {
	return native.visibleWidth(text, tabWidth);
}

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
export function extractSegments(
	line: string,
	beforeEnd: number,
	afterStart: number,
	afterLen: number,
	strictAfter: boolean,
	tabWidth = getDefaultTabWidth(),
): ExtractSegmentsResult {
	return native.extractSegments(line, beforeEnd, afterStart, afterLen, strictAfter, tabWidth);
}

export const { sanitizeText } = native;

/**
 * Defensive boundary against a class of inputs known to hang the native
 * `wrap_text_with_ansi` in shipped binaries (a long contiguous token containing
 * a lone/invalid ESC byte triggers an infinite loop in `break_long_word` of
 * `crates/pi-natives/src/text.rs` versions <= 15.5.13). Source is fixed but
 * any user still on an older cached binary would otherwise deadlock the TUI
 * render thread with no signal. Stripping the offending byte at the JS edge
 * preserves visible content (lone ESCs render as nothing in a terminal anyway)
 * and is a no-op on healthy binaries.
 *
 * Cheap fast path: bail when the text has no ESC byte at all (overwhelming
 * majority of calls).
 */
let warnedOnSanitize = false;
function sanitizeWrapInput(text: string): string {
	if (text.indexOf("\x1b") < 0) return text;
	const cleaned = stripLoneEscFromLongTokens(text);
	if (cleaned !== text && !warnedOnSanitize) {
		warnedOnSanitize = true;
		try {
			const { logger } = require("@spell/pi-utils");
			logger?.warn?.(
				"wrapTextWithAnsi: stripped lone ESC byte from a long token to avoid known native deadlock (pi-natives <= 15.5.13). Update pi-natives or rebuild.",
			);
		} catch {
			/* logger optional */
		}
	}
	return cleaned;
}

/**
 * Walks the string once and rewrites any lone ESC inside a non-whitespace run
 * longer than 32 chars. "Lone" = the ESC is not followed by a valid CSI/OSC/SS3
 * intro that the native parser recognises. We err on the side of stripping: the
 * native `wrap_text_with_ansi` already gracefully passes valid SGR sequences
 * inside long tokens (it loops on them, advancing by `seq_len`); only the lone
 * case caused the bug. So if the ESC is clearly inside a CSI/OSC sequence we
 * leave it alone, otherwise we drop it.
 */
function stripLoneEscFromLongTokens(text: string): string {
	const len = text.length;
	let out = "";
	let runStart = 0;
	for (let i = 0; i <= len; i++) {
		const end = i === len || isWrapBoundary(text.charCodeAt(i));
		if (!end) continue;
		const runLen = i - runStart;
		if (runLen > 32 && containsLoneEsc(text, runStart, i)) {
			out += scrubRun(text, runStart, i);
		} else {
			out += text.slice(runStart, i);
		}
		if (i < len) out += text[i];
		runStart = i + 1;
	}
	return out;
}

function isWrapBoundary(code: number): boolean {
	// Treat all ASCII whitespace as word boundaries, matching the native
	// `split_into_tokens_with_ansi` boundary set. Other separators (punctuation)
	// are intentionally NOT boundaries because the native treats long runs of
	// e.g. base64 or hex as a single token.
	return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0b || code === 0x0c;
}

function containsLoneEsc(text: string, start: number, end: number): boolean {
	for (let i = start; i < end; i++) {
		if (text.charCodeAt(i) === 0x1b && !isValidAnsiIntro(text, i, end)) return true;
	}
	return false;
}

function scrubRun(text: string, start: number, end: number): string {
	let out = "";
	for (let i = start; i < end; i++) {
		if (text.charCodeAt(i) === 0x1b && !isValidAnsiIntro(text, i, end)) continue;
		out += text[i];
	}
	return out;
}

/**
 * Mirrors the prefix shape of `ansi_seq_len_u16` in `crates/pi-natives/src/text.rs`:
 * an ESC is valid iff followed by `[` (CSI), `]` (OSC), `P` (DCS), `_` (APC),
 * `^` (PM), or `O` (SS3). We don't require the full sequence to be well-formed
 * — the native handles malformed-but-introducer-prefixed ESC correctly; only
 * the bare-ESC case is dangerous.
 */
function isValidAnsiIntro(text: string, pos: number, end: number): boolean {
	if (pos + 1 >= end) return false;
	const c = text.charCodeAt(pos + 1);
	return c === 0x5b /*[*/ || c === 0x5d /*]*/ || c === 0x50 /*P*/ || c === 0x5f /*_*/ || c === 0x5e /*^*/ || c === 0x4f /*O*/;
}


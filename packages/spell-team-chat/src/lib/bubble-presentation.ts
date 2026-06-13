/**
 * Pure presentation helpers for chat tool bubbles. No runes here, so this module
 * is import-safe from bun:test (same convention as reducers.ts).
 *
 * Tool bubbles used to render as raw slabs: a `tool_start` carries `args` but no
 * `text` (→ "(empty)"), and a `tool_end` dumps an unstyled diff. These helpers
 * give the chat log the same structured-tile vocabulary as the side panels —
 * a compact target chip for starts, and per-line add/remove/hunk accents for diffs.
 */

/** Fields that best identify a tool's target, in priority order. */
const PRIMARY_ARG_KEYS = ["target", "path", "file", "command", "query", "url", "pattern"] as const;

const MAX_SUMMARY_LEN = 120;

/**
 * Compact one-line summary of a tool's args for a tool_start tile. Returns the
 * most identifying string field, else a short key list, else null (truly empty
 * args). Never throws on non-object input.
 */
export function summariseArgs(args: unknown): string | null {
	if (!args || typeof args !== "object") return null;
	const a = args as Record<string, unknown>;
	for (const k of PRIMARY_ARG_KEYS) {
		const v = a[k];
		if (typeof v === "string" && v.length > 0) {
			return v.length > MAX_SUMMARY_LEN ? `${v.slice(0, MAX_SUMMARY_LEN - 1)}…` : v;
		}
	}
	const keys = Object.keys(a).filter((k) => a[k] !== undefined && a[k] !== null);
	return keys.length ? keys.slice(0, 4).join(", ") : null;
}

export type DiffLineClass = "add" | "del" | "hunk" | "ctx";
export interface DiffLine {
	cls: DiffLineClass;
	text: string;
}

/** True when `text` contains at least one unified-diff marker line. */
export function looksLikeDiff(text: string): boolean {
	return /(^|\n)[+\-@]/.test(text);
}

/**
 * Classify each line of a unified-diff-ish body. Returns null when the body has
 * no diff markers (caller renders it as a plain block instead).
 */
export function classifyDiffLines(text: string): DiffLine[] | null {
	if (!looksLikeDiff(text)) return null;
	return text.split("\n").map((line): DiffLine => {
		if (line.startsWith("@@")) return { cls: "hunk", text: line };
		if (line.startsWith("+")) return { cls: "add", text: line };
		if (line.startsWith("-")) return { cls: "del", text: line };
		return { cls: "ctx", text: line };
	});
}

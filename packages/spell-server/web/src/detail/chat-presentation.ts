/**
 * Pure presentation helpers for the structured chat stream. No React here, so
 * these are unit-testable headlessly.
 *
 * The Stream tab renders agent RPC events as structured DOM bubbles. A
 * tool_execution_start carries `args` but no text; a tool_execution_end carries
 * a result whose content may be a unified diff. These helpers turn those into a
 * compact target chip and per-line diff accents.
 */

/** Fields that best identify a tool's target, in priority order. */
const PRIMARY_ARG_KEYS = ["target", "path", "file", "command", "query", "url", "pattern"] as const;
const MAX_SUMMARY_LEN = 120;

/**
 * Compact one-line summary of a tool's args for a tool-start tile. Returns the
 * most identifying string field, else a short key list, else null. Never throws.
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
	const keys = Object.keys(a).filter(k => a[k] !== undefined && a[k] !== null);
	return keys.length ? keys.slice(0, 4).join(", ") : null;
}

export type DiffLineClass = "add" | "del" | "hunk" | "ctx";
export interface DiffLine {
	cls: DiffLineClass;
	text: string;
}


/**
 * True only for a real unified diff: a `@@ … @@` hunk header must be present.
 * Requiring the hunk header avoids misclassifying markdown bullet lists (lines
 * starting with `-` / `+`) or quoted text as a diff.
 */
export function looksLikeDiff(text: string): boolean {
	return /(^|\n)@@ /.test(text);
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

export type EditIntent = "undo" | "redo" | "declined";

/**
 * Classify an `edit` tool result by its leading line so undo/redo/declined read
 * clearly. The kernel renders recognisable leads: "undo · <file>",
 * "redo · <file>", or "undo declined: already committed — …".
 */
export function classifyEditResult(toolName: string | undefined, text: string | undefined): EditIntent | null {
	if (toolName !== "edit" || !text) return null;
	const t = text.trimStart();
	if (/^undo declined/i.test(t) || /declined: already committed/i.test(t)) return "declined";
	if (/^undo[\s·]/.test(t)) return "undo";
	if (/^redo[\s·]/.test(t)) return "redo";
	return null;
}

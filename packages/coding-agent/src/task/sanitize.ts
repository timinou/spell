/**
 * Sanitization helpers for auto-roster task dispatch.
 *
 * Extracted to avoid circular imports — index.ts → tools/index.ts → task/index.ts.
 */

const STRUCTURAL_HEADINGS = new Set(["Goal", "Non-goals", "Constraints", "API Contract", "Acceptance"]);
const ESCAPED_NEWLINE_SEQUENCE = /\\r\\n|\\r|\\n/g;
const REAL_NEWLINE_SEQUENCE = /\r\n|\r|\n/g;
const ANY_NEWLINE_SEQUENCE = /\\r\\n|\\r|\\n|\r\n|\r|\n/g;

function sanitizePhaseName(raw: string): string {
	return raw.replace(ANY_NEWLINE_SEQUENCE, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

/** Normalize literal newline sequences and extract a phase name from context. */
export function deriveAutoRosterPhaseNameFromContext(
	context: string | undefined,
	explicitPhase: string | undefined,
): string {
	const explicit = explicitPhase ? sanitizePhaseName(explicitPhase) : "";
	if (explicit) return explicit;
	const normalized = context?.replace(ESCAPED_NEWLINE_SEQUENCE, "\n").replace(REAL_NEWLINE_SEQUENCE, "\n") ?? "";
	const lines = normalized.split("\n").map(line => line.trim());
	for (const line of lines) {
		if (!/^#{1,6}\s+\S/.test(line)) continue;
		const text = sanitizePhaseName(line.replace(/^#{1,6}\s+/, ""));
		if (!STRUCTURAL_HEADINGS.has(text)) return text;
	}
	return "Tasks";
}

/** Strip newlines (real and literal escaped sequences) from task description for todo content. */
export function sanitizeTaskContent(description: string, fallbackId: string): string {
	return description.replace(ANY_NEWLINE_SEQUENCE, " ").trim() || fallbackId;
}

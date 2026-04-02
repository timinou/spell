/**
 * Sanitization helpers for auto-roster task dispatch.
 *
 * Extracted to avoid circular imports — index.ts → tools/index.ts → task/index.ts.
 */

const STRUCTURAL_HEADINGS = new Set(["Goal", "Non-goals", "Constraints", "API Contract", "Acceptance"]);

/** Normalize literal \\n sequences and extract a phase name from context. */
export function deriveAutoRosterPhaseNameFromContext(
	context: string | undefined,
	explicitPhase: string | undefined,
): string {
	const explicit = explicitPhase?.trim();
	if (explicit) return explicit;
	const normalized = context?.replace(/\\n/g, "\n") ?? "";
	const lines = normalized.split("\n").map(line => line.trim());
	for (const line of lines) {
		if (!/^#{1,6}\s+\S/.test(line)) continue;
		const text = line.replace(/^#{1,6}\s+/, "").trim();
		if (!STRUCTURAL_HEADINGS.has(text)) return text.slice(0, 80);
	}
	return "Tasks";
}

/** Strip newlines (real and literal \\n) from task description for todo content. */
export function sanitizeTaskContent(description: string, fallbackId: string): string {
	return description.replace(/\\n|\n/g, " ").trim() || fallbackId;
}

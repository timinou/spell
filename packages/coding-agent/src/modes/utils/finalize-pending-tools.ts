/**
 * Finalize pending tool cells left without a terminal result.
 *
 * A tool cell renders as permanently "pending" (bare title, no result icon,
 * no output) whenever its component never receives a non-partial
 * `updateResult`. This happens whenever an assistant `toolCall` has no matching
 * `toolResult`:
 *
 * - live: a hard process kill / abort leaves a `pendingTools` entry that never
 *   gets a `tool_execution_end` before `agent_end`.
 * - replay: a transcript with an unpaired `toolCall` (e.g. crashed mid-run)
 *   renders a cell that the result-matching loop never finalizes.
 *
 * Both sites previously dropped the tracking entry without finalizing the
 * component, freezing the cell in pending state. This helper is the single
 * cutover point: it flips every non-background leftover to a terminal error
 * state and removes it from tracking. Genuinely-still-running background calls
 * (async bash, background tasks) are preserved untouched.
 */

/** Minimal structural type shared by tool cell components. */
export interface FinalizableToolComponent {
	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: unknown;
			isError?: boolean;
		},
		isPartial?: boolean,
		toolCallId?: string,
	): void;
}

/** Sentinel shown in a cell finalized without a recorded result. */
export const INTERRUPTED_TOOL_RESULT_TEXT = "Interrupted (no result recorded)";

/**
 * Finalize and detach every pending tool cell that is not a live background
 * call. Mutates `pendingTools` in place.
 *
 * @returns the toolCallIds that were finalized.
 */
export function finalizeOrphanPendingTools(
	pendingTools: Map<string, FinalizableToolComponent>,
	backgroundToolCallIds: ReadonlySet<string>,
	text: string = INTERRUPTED_TOOL_RESULT_TEXT,
): string[] {
	const finalized: string[] = [];
	for (const [toolCallId, component] of Array.from(pendingTools.entries())) {
		if (backgroundToolCallIds.has(toolCallId)) continue;
		component.updateResult({ content: [{ type: "text", text }], isError: true }, false, toolCallId);
		pendingTools.delete(toolCallId);
		finalized.push(toolCallId);
	}
	return finalized;
}

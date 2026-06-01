/**
 * Ghost-cell reaper for the event controller.
 *
 * Defends against a class of UI freezes caused by provider stream retries.
 *
 * ## The bug being defended against
 *
 * `packages/ai/src/providers/anthropic.ts` contains an in-provider retry loop:
 * on transient SSE stalls (idle-timeout, parse error mid-frame) it does
 *
 * ```
 * providerRetryAttempt++;
 * output.content.length = 0;       // wipes content blocks
 * output.stopReason = "stop";
 * firstTokenTime = undefined;
 * started = false;                 // loop reruns the for-await against fresh message_start
 * ```
 *
 * and re-runs the SSE consumer. But the outer agent-event stream has ALREADY
 * shipped `message_update` events whose partial messages carry the toolCall ids
 * (a1..aN) of the wiped blocks. The reducer's own state forgets them; the agent
 * loop and event-controller don't. New ids (b1..bM) from the retry then arrive,
 * the controller creates additional cells for them, and the dead a1..aN cells
 * sit in `pendingTools` forever — `tool_execution_start` never fires for them
 * because the executor only sees the final, post-retry content set. The visible
 * symptom is the LiveToolBatch panel showing e.g. `Tools (72) · 0 done · 72
 * running` for a turn that, post-retry, actually only had ~18 real calls.
 *
 * This regression hit `claude-opus-4.8` much more than `4.7` because Opus 4.8
 * has denser per-message generation, longer think windows, and stalls the SSE
 * more often, firing the retry path enough times to compound the ghost count.
 *
 * ## What this helper does
 *
 * On every `message_update`, the controller computes `liveIds` = ids currently
 * present in `partial.content` and calls {@link reapGhostStreamingCells}. The
 * helper removes any cell whose id was registered for THIS streaming message
 * but is no longer in `liveIds`. Background-async cells (e.g. running async
 * bash) are preserved because their toolCallId is not in
 * `streamingToolCallIds` either — they belong to an earlier turn.
 *
 * ## Layer B (future)
 *
 * The structurally correct fix is to remove the in-provider content-wipe
 * pattern altogether (upstream pi-mono does NOT do this — its anthropic
 * provider treats a stalled stream as a hard error and lets the agent loop
 * decide retry at the higher layer where re-issuing the full request is the
 * right primitive). This helper exists so we can ship the Layer-A defensive
 * sweep today without coupling to the Layer-B provider rewrite.
 */

/**
 * Component shape compatible with both ToolExecutionComponent and the
 * group containers (ReadToolGroupComponent, LiveToolBatchComponent).
 */
export interface ReapableComponent {
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

/**
 * Group component that knows how to remove a cell by id (LiveToolBatch). For
 * groups without removal support we fall back to finalize-as-error so the row
 * still shows a terminal state instead of staying pending forever.
 */
export interface RemovableGroup extends ReapableComponent {
	removeCell(id: string): boolean;
}

function isRemovableGroup(c: ReapableComponent): c is RemovableGroup {
	return typeof (c as Partial<RemovableGroup>).removeCell === "function";
}

/** Text used when a ghost cell falls back to finalize-as-error. */
export const GHOST_REAPER_FINALIZE_TEXT = "Discarded: provider stream restarted";

export interface ReapResult {
	/** Ids that were definitively detached (either removed or finalized). */
	reaped: string[];
	/** Ids removed from a removable group (LiveToolBatch). */
	removed: string[];
	/** Ids finalized in-place because their host group has no remove API. */
	finalized: string[];
}

/**
 * Reconcile pendingTools against the live id set of the current streaming
 * message.
 *
 * Mutates `pendingTools` and `streamingToolCallIds` in place.
 *
 * @param pendingTools          live mapping from toolCallId → host component
 * @param streamingToolCallIds  ids that were materialised for the CURRENT
 *                              streaming assistant message
 * @param backgroundToolCallIds ids whose host represents a live async/background
 *                              run; these must never be reaped
 * @param liveIds               ids currently present in `partial.content`
 *                              (toolCall blocks)
 */
export function reapGhostStreamingCells(
	pendingTools: Map<string, ReapableComponent>,
	streamingToolCallIds: Set<string>,
	backgroundToolCallIds: ReadonlySet<string>,
	liveIds: ReadonlySet<string>,
): ReapResult {
	const result: ReapResult = { reaped: [], removed: [], finalized: [] };
	if (streamingToolCallIds.size === 0) return result;

	const ghosts: string[] = [];
	for (const id of streamingToolCallIds) {
		if (!liveIds.has(id)) ghosts.push(id);
	}
	if (ghosts.length === 0) return result;

	for (const id of ghosts) {
		streamingToolCallIds.delete(id);
		if (backgroundToolCallIds.has(id)) continue;
		const component = pendingTools.get(id);
		if (!component) continue;

		if (isRemovableGroup(component) && component.removeCell(id)) {
			pendingTools.delete(id);
			result.removed.push(id);
			result.reaped.push(id);
			continue;
		}

		component.updateResult(
			{ content: [{ type: "text", text: GHOST_REAPER_FINALIZE_TEXT }], isError: true },
			false,
			id,
		);
		pendingTools.delete(id);
		result.finalized.push(id);
		result.reaped.push(id);
	}

	return result;
}

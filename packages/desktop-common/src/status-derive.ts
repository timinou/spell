import type { AgentStatus, TodoPhaseView } from "./types";

/**
 * Minimal context needed to derive an agent's status.
 * Kept narrow so any platform can satisfy it without importing
 * the full coding-agent session type.
 */
export interface AgentStatusContext {
	/** True when the LLM is actively streaming. */
	isStreaming: boolean;
	/** Non-undefined error string when the session is in an error state. */
	error?: string;
	/** True when plan approval is pending. */
	isPendingApproval?: boolean;
	/** True when the agent is paused mid-stream for a hook UI (ask, etc.). */
	isAwaitingHookInput?: boolean;
	/** True when the user has acknowledged needs_input and wants to be left alone. */
	isUserPaused?: boolean;
	/** Defined when the main-loop input callback is awaiting user input. */
	hasInputCallback?: boolean;
	/** Current todo phases — used to detect "all done" → completed. */
	todoPhases: TodoPhaseView[];
}

/**
 * Derive the agent status from session context.
 *
 * Precedence:
 *  1. error
 *  2. pending_approval
 *  3. needs_input / user_paused (hook input)
 *  4. running (streaming)
 *  5. user_paused / completed / needs_input (input callback) — an explicit
 *     user pause always wins over the derived "all done" check.
 *  6. idle
 */
export function deriveAgentStatus(ctx: AgentStatusContext): AgentStatus {
	if (ctx.error) return "error";
	if (ctx.isPendingApproval) return "pending_approval";
	if (ctx.isAwaitingHookInput) return ctx.isUserPaused ? "user_paused" : "needs_input";
	if (ctx.isStreaming) return "running";
	if (ctx.hasInputCallback) {
		// An explicit user pause is a deliberate acknowledgement — it must win
		// over the derived "all done" check, else a session paused after its
		// last todo completes silently reverts to "completed" and its paused
		// indicator (e.g. the dms workspace-chip circle) disappears.
		if (ctx.isUserPaused) return "user_paused";
		const allDone =
			ctx.todoPhases.length > 0 &&
			ctx.todoPhases.every(p => p.tasks.every(t => t.status === "completed" || t.status === "abandoned"));
		if (allDone) return "completed";
		return "needs_input";
	}
	return "idle";
}

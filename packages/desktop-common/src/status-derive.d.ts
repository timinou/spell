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
 *  5. needs_input / user_paused / completed (input callback)
 *  6. idle
 */
export declare function deriveAgentStatus(ctx: AgentStatusContext): AgentStatus;
//# sourceMappingURL=status-derive.d.ts.map
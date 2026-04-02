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
export function deriveAgentStatus(ctx) {
    if (ctx.error)
        return "error";
    if (ctx.isPendingApproval)
        return "pending_approval";
    if (ctx.isAwaitingHookInput)
        return ctx.isUserPaused ? "user_paused" : "needs_input";
    if (ctx.isStreaming)
        return "running";
    if (ctx.hasInputCallback) {
        const allDone = ctx.todoPhases.length > 0 &&
            ctx.todoPhases.every(p => p.tasks.every(t => t.status === "completed" || t.status === "abandoned"));
        if (allDone)
            return "completed";
        return ctx.isUserPaused ? "user_paused" : "needs_input";
    }
    return "idle";
}
//# sourceMappingURL=status-derive.js.map
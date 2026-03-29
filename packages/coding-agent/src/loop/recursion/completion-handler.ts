import type { ChildCompletionSignal } from "../contracts";
import { CHILD_OUTCOMES } from "../contracts";
import type { LoopRetryPolicy } from "../types";

export interface ChildCompletionAction {
	action: "continue" | "retry" | "block" | "skip" | "escalate";
	reason: string;
}

export function applyChildCompletionPolicy(
	signal: ChildCompletionSignal,
	policy: LoopRetryPolicy,
	attempts: number,
): ChildCompletionAction {
	if (signal.outcome === CHILD_OUTCOMES.success) {
		return { action: "continue", reason: signal.summary };
	}
	if (policy.policy === "retry" && attempts < (policy.retries ?? 0)) {
		return { action: "retry", reason: `Retrying child ${signal.childLoopId} (${attempts + 1}/${policy.retries})` };
	}
	if (policy.policy === "skip") {
		return { action: "skip", reason: `Skipping failed child ${signal.childLoopId}` };
	}
	if (policy.policy === "escalate") {
		return { action: "escalate", reason: `Escalating failed child ${signal.childLoopId}` };
	}
	return { action: "block", reason: `Blocking on child ${signal.childLoopId}` };
}

import type { LoopSnapshot } from "../types";

export interface BudgetCheckResult {
	exceeded: boolean;
	reason?: string;
}

export function checkBudget(loop: LoopSnapshot, now: number): BudgetCheckResult {
	if (loop.budgetLimits.wallClockMs > 0 && now - loop.startedAt > loop.budgetLimits.wallClockMs) {
		return { exceeded: true, reason: `Wall-clock budget exceeded (${loop.budgetLimits.wallClockMs}ms)` };
	}
	if (loop.budgetLimits.maxTreeIterations > 0 && loop.totalTreeIterations >= loop.budgetLimits.maxTreeIterations) {
		return {
			exceeded: true,
			reason: `Iteration budget exceeded (${loop.budgetLimits.maxTreeIterations})`,
		};
	}
	return { exceeded: false };
}

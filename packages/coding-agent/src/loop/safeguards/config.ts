import { DEFAULT_BUDGET_LIMITS } from "../constants";
import type { LoopBudgetLimits } from "../types";

export function resolveBudgetLimits(overrides?: Partial<LoopBudgetLimits>): LoopBudgetLimits {
	return {
		wallClockMs: overrides?.wallClockMs ?? DEFAULT_BUDGET_LIMITS.wallClockMs,
		maxTreeIterations: overrides?.maxTreeIterations ?? DEFAULT_BUDGET_LIMITS.maxTreeIterations,
		maxIdleIterations: overrides?.maxIdleIterations ?? DEFAULT_BUDGET_LIMITS.maxIdleIterations,
	};
}

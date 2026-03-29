import type { LoopSnapshot } from "../types";

export function detectRunaway(loop: LoopSnapshot, progressHash: string): { runaway: boolean; idleIterations: number } {
	const idleIterations = loop.lastProgressHash === progressHash ? loop.budgetStatus.idleIterations + 1 : 0;
	return {
		runaway: loop.budgetLimits.maxIdleIterations > 0 && idleIterations >= loop.budgetLimits.maxIdleIterations,
		idleIterations,
	};
}

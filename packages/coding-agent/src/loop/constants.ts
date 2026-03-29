export const LOOP_SCHEMA_VERSION = "1.0.0";
export const DEFAULT_LOOP_MAX_ITERATIONS = 200;
export const DEFAULT_LOOP_REFLECT_EVERY = 3;
export const DEFAULT_LOOP_DEPTH_LIMIT = 3;
export const DEFAULT_LOOP_CONCURRENCY_LIMIT = 2;
export const DEFAULT_HUMAN_GATE_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_BUDGET_LIMITS = {
	wallClockMs: 4 * 60 * 60 * 1000,
	maxTreeIterations: 200,
	maxIdleIterations: 5,
} as const;

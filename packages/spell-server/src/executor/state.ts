export type GoalExecutionState = "pending" | "running" | "completed" | "failed" | "retrying" | "escalated" | "paused";

const VALID_TRANSITIONS: Record<GoalExecutionState, GoalExecutionState[]> = {
	pending: ["running"],
	running: ["completed", "failed"],
	completed: [],
	failed: ["retrying", "escalated"],
	retrying: ["running", "escalated"],
	escalated: ["paused"],
	paused: [],
};

export function isValidTransition(from: GoalExecutionState, to: GoalExecutionState): boolean {
	return VALID_TRANSITIONS[from].includes(to);
}

export function transition(from: GoalExecutionState, to: GoalExecutionState): GoalExecutionState {
	if (!isValidTransition(from, to)) {
		throw new Error(`Invalid state transition: ${from} -> ${to}`);
	}
	return to;
}

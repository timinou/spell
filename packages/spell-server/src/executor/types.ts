import type { ManifestGoal, ManifestSetup } from "../manifest/types";

export type GoalRunStatus = "running" | "completed" | "failed" | "timeout";

export interface GoalRun {
	runId: string;
	goalName: string;
	startedAt: Date;
	completedAt?: Date;
	status: GoalRunStatus;
	error?: string;
	attempt: number;
}

export interface GoalExecutionConfig {
	cwd: string;
	setup: ManifestSetup;
	goal: ManifestGoal;
}

export interface GoalResult {
	goalName: string;
	status: "success" | "failure";
	duration: number;
	error?: string;
	summary?: string;
	runs: GoalRun[];
}

import type { GoalExecutionState } from "../executor/state";
import type { GoalRunStatus } from "../executor/types";

export interface GoalSummary {
	name: string;
	setup: string;
	schedule: string;
	status: GoalExecutionState;
	lastRun?: {
		completedAt: string;
		status: GoalRunStatus;
	};
	nextFire?: string;
}

export interface RunEntry {
	runId: string;
	startedAt: string;
	completedAt?: string;
	status: GoalRunStatus;
	error?: string;
	attempt: number;
}

export interface GoalDetail extends GoalSummary {
	config: unknown;
	runs: RunEntry[];
}

export interface ServerConfig {
	port: number;
	auth: {
		username: string;
		password: string;
	};
	webhookSecret?: string;
	goalTokens?: Record<string, string>;
}

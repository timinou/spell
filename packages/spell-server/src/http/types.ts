import type { GoalExecutionState } from "../executor/state";
import type { GoalRunStatus } from "../executor/types";
import type {
	WorkflowArtifactRef,
	WorkflowAuditEntry,
	WorkflowDownstreamAttempt,
	WorkflowDownstreamJob,
	WorkflowItem,
} from "../workflow/types";

export interface GoalSummary {
	name: string;
	setup: string;
	schedule: string;
	actionId?: string;
	status: GoalExecutionState;
	lastRun?: {
		completedAt: string;
		status: GoalRunStatus;
	};
	nextFire?: string;
	runCount: number;
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

export interface ApprovalListEntry {
	id: string;
	kind: WorkflowItem["kind"];
	workflowId: string;
	targetId: string;
	title: string;
	state: string;
	allowedActions: string[];
	claim?: {
		actorId: string;
		expiresAt: string;
	};
	updatedAt: string;
	artifactCount: number;
	linkedGoal?: string;
	linkedRunId?: string;
}

export interface DownstreamAttemptEntry extends WorkflowDownstreamAttempt {}

export interface DownstreamJobEntry {
	id: string;
	itemId: string;
	kind: string;
	status: WorkflowDownstreamJob["status"];
	retryEligible: boolean;
	attempts: DownstreamAttemptEntry[];
	updatedAt: string;
}

export interface ApprovalDetail extends ApprovalListEntry {
	summary?: string;
	metadata: Record<string, unknown>;
	artifacts: WorkflowArtifactRef[];
	audit: WorkflowAuditEntry[];
	downstreamJobs: DownstreamJobEntry[];
}

/**
 * Identity attached to an authenticated /web/* request. The `name` is the
 * key under which the matching token was registered in `WebConfig.tokens`.
 */
export interface WebIdentity {
	name: string;
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

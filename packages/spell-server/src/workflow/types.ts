export type WorkflowPrimitive = string | number | boolean | null;
export type WorkflowValue = WorkflowPrimitive | WorkflowValue[] | { [key: string]: WorkflowValue };

export type WorkflowItemKind = "approval" | "checkpoint";
export type WorkflowJobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
export type WorkflowAttemptStatus = "RUNNING" | "SUCCEEDED" | "FAILED";

export interface WorkflowActor {
	actorId: string;
	source: string;
	displayName?: string;
	roles?: string[];
}

export interface WorkflowClaim {
	actor: WorkflowActor;
	acquiredAt: string;
	expiresAt: string;
	override: boolean;
}

export interface WorkflowArtifactRef {
	id: string;
	label: string;
	path: string;
	mediaType?: string;
	supersedes?: string[];
}

export interface WorkflowDownstreamSpec {
	kind: string;
	payload?: Record<string, WorkflowValue>;
	retryEligible?: boolean;
}

export interface WorkflowNotificationRoute {
	channel: "telegram" | "generic";
	target: string;
	template?: string;
}

export interface SpawnApprovalTemplate {
	workflowId: string;
	targetId: string;
	title: string;
	summary?: string;
	actions: WorkflowActionDefinition[];
	metadata?: Record<string, WorkflowValue>;
	artifacts?: WorkflowArtifactRef[];
	notificationRoutes?: WorkflowNotificationRoute[];
	claimLeaseMs?: number;
}

export type CheckpointEffect =
	| { type: "resume-run" }
	| { type: "fail-run" }
	| { type: "trigger-goal"; goalName: string }
	| { type: "create-approval"; approval: SpawnApprovalTemplate };

export interface WorkflowActionDefinition {
	id: string;
	label: string;
	fromStates: string[];
	toState: string;
	requiresReason?: boolean;
	artifactMode?: "immutable" | "append" | "replace";
	downstreamJobs?: WorkflowDownstreamSpec[];
	checkpointEffect?: CheckpointEffect;
}

export interface WorkflowItemBase {
	id: string;
	kind: WorkflowItemKind;
	workflowId: string;
	targetId: string;
	title: string;
	summary?: string;
	state: string;
	actions: WorkflowActionDefinition[];
	metadata: Record<string, WorkflowValue>;
	artifacts: WorkflowArtifactRef[];
	notificationRoutes: WorkflowNotificationRoute[];
	claimLeaseMs: number;
	claim?: WorkflowClaim;
	linkedGoal?: string;
	linkedRunId?: string;
	linkedCheckpointId?: string;
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
}

export interface WorkflowApprovalItem extends WorkflowItemBase {
	kind: "approval";
}

export interface WorkflowCheckpointItem extends WorkflowItemBase {
	kind: "checkpoint";
	runStatus: "paused" | "resumed" | "failed";
}

export type WorkflowItem = WorkflowApprovalItem | WorkflowCheckpointItem;

export interface WorkflowDownstreamAttempt {
	id: string;
	status: WorkflowAttemptStatus;
	startedAt: string;
	finishedAt?: string;
	error?: string;
	artifactPath?: string;
}

export interface WorkflowDownstreamJob {
	id: string;
	itemId: string;
	kind: string;
	status: WorkflowJobStatus;
	retryEligible: boolean;
	payload: Record<string, WorkflowValue>;
	createdAt: string;
	updatedAt: string;
	attempts: WorkflowDownstreamAttempt[];
}

export interface WorkflowAuditEntry {
	id: string;
	at: string;
	kind:
		| "item-created"
		| "claim-acquired"
		| "claim-released"
		| "claim-expired"
		| "action-applied"
		| "request-duplicate"
		| "request-stale"
		| "downstream-queued"
		| "downstream-started"
		| "downstream-succeeded"
		| "downstream-failed"
		| "notification-failed";
	itemId?: string;
	jobId?: string;
	actor?: WorkflowActor;
	requestId?: string;
	message: string;
	data?: Record<string, WorkflowValue>;
}

export interface WorkflowRequestRecord {
	requestId: string;
	itemId: string;
	outcome: "applied" | "duplicate" | "stale";
	at: string;
}

export interface WorkflowCreateItemInput {
	workflowId: string;
	targetId: string;
	title: string;
	summary?: string;
	initialState?: string;
	actions: WorkflowActionDefinition[];
	metadata?: Record<string, WorkflowValue>;
	artifacts?: WorkflowArtifactRef[];
	notificationRoutes?: WorkflowNotificationRoute[];
	claimLeaseMs?: number;
	linkedGoal?: string;
	linkedRunId?: string;
	linkedCheckpointId?: string;
}

export interface WorkflowCreateCheckpointInput extends WorkflowCreateItemInput {
	runStatus?: WorkflowCheckpointItem["runStatus"];
}

export interface WorkflowClaimInput {
	itemId: string;
	actor: WorkflowActor;
	requestId: string;
	force?: boolean;
}

export interface WorkflowReleaseClaimInput {
	itemId: string;
	actor: WorkflowActor;
	requestId: string;
	force?: boolean;
}

export interface WorkflowApplyActionInput {
	itemId: string;
	actionId: string;
	actor: WorkflowActor;
	requestId: string;
	reason?: string;
	artifacts?: WorkflowArtifactRef[];
	force?: boolean;
}

export interface WorkflowApplyActionResult {
	item: WorkflowItem;
	duplicate: boolean;
	stale: boolean;
	triggeredGoals: string[];
	spawnedApproval?: WorkflowApprovalItem;
	queuedJobs: WorkflowDownstreamJob[];
	effect?: CheckpointEffect;
}

export interface WorkflowItemFilter {
	kind?: WorkflowItemKind;
	state?: string;
	workflowId?: string;
}

export interface WorkflowJobFilter {
	kind?: string;
	status?: WorkflowJobStatus;
	itemId?: string;
}

export interface WorkflowNotificationMessage {
	item: WorkflowItem;
	actionId: string;
	route: WorkflowNotificationRoute;
}

export interface WorkflowNotificationSender {
	send(message: WorkflowNotificationMessage): Promise<void>;
}

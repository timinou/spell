import type { Model } from "@oh-my-pi/pi-ai";
import type { TSchema } from "@sinclair/typebox";
import type {
	ChildCompletionSignal,
	FailurePolicy,
	GateDecision,
	GateTrigger,
	GateType,
	HandoffArtifact,
	IterationCheckpoint,
	LoopRole,
	LoopState,
	TicketState,
} from "./contracts";

export interface LoopBudgetLimits {
	wallClockMs: number;
	maxTreeIterations: number;
	maxIdleIterations: number;
}

export interface LoopBudgetStatus {
	elapsedMs: number;
	treeIterations: number;
	idleIterations: number;
}

export interface LoopPromptContext extends Record<string, unknown> {
	loopId: string;
	name: string;
	iteration: number;
	state: LoopState;
	summary?: string;
	taskContent?: string;
	changedFiles: string[];
	openFindings: string[];
	pendingGates: string[];
	manifestTickets?: Array<{
		id: string;
		title: string;
		state: string;
		dependencies: string[];
		hasGates: boolean;
		effort?: string;
		priority?: string;
	}>;
	manifestProgress?: string;
	readyTickets?: string[];
	activeTickets?: string[];
	completedTickets?: string[];
	manifestComplete?: boolean;
}

export interface LoopRoleSelection {
	role: LoopRole;
	model?: Model;
}

export interface LoopRuntimeEvent {
	type: string;
	loopId: string;
	parentLoopId?: string;
	timestamp: number;
	payload: Record<string, unknown>;
}

export interface LoopGateTriggerConfig {
	kind: GateTrigger;
	every?: number;
}

export interface LoopRetryPolicy {
	policy: FailurePolicy;
	retries?: number;
}

export interface BaseGateConfig {
	id: string;
	type: GateType;
	trigger: LoopGateTriggerConfig;
	maxAttempts?: number;
	onFail?: FailurePolicy;
	timeoutMs?: number;
	priority?: number;
	autoApproveAfterMs?: number;
}

export interface CommandGateConfig extends BaseGateConfig {
	type: "command";
	command: string;
	cwd?: string;
	passPattern?: string;
}

export interface LlmReviewGateConfig extends BaseGateConfig {
	type: "llm-review";
	criteria: string;
}

export interface ArtifactGateConfig extends BaseGateConfig {
	type: "artifact";
	path: string;
	regex?: string;
	jsonSchema?: TSchema;
}

export interface HumanGateConfig extends BaseGateConfig {
	type: "human";
	prompt: string;
}

export type LoopGateConfig = CommandGateConfig | LlmReviewGateConfig | ArtifactGateConfig | HumanGateConfig;

export interface LoopDomainDefinition {
	name: string;
	description: string;
	guidelinesTemplate: string;
	defaultGates: LoopGateConfig[];
	evidenceCollector?: (loop: LoopSnapshot) => Promise<string[]> | string[];
}

export interface LoopReadinessResult {
	ok: boolean;
	required: Array<{ name: string; ok: boolean; message: string }>;
	advisory: Array<{ name: string; ok: boolean; message: string }>;
	missingGuidelineDomains: string[];
}

export interface LoopTreeEdge {
	parentLoopId: string;
	childLoopId: string;
	required: boolean;
	failurePolicy: LoopRetryPolicy;
	attempts: number;
}

export interface LoopPendingHumanGate {
	loopId: string;
	gateId: string;
	prompt: string;
	autoApproveAt?: number;
}

export interface ManifestTicket {
	id: string;
	title: string;
	state: TicketState;
	specPath?: string;
	orgItemId?: string;
	acceptanceCriteria: string[];
	dependencies: string[];
	triggers: string[];
	gates: LoopGateConfig[];
	effort?: string;
	priority?: string;
	layer?: string;
	tags: string[];
	changedFiles: string[];
	findings: string[];
	childLoopId?: string;
	iterationHistory: number[];
}

export interface ManifestSnapshot {
	version: number;
	tickets: ManifestTicket[];
	dependencyEdges: Array<{ from: string; to: string }>;
	triggerRules: Array<{ source: string; target: string; keyword: string }>;
	manifestOrgPath: string;
	createdAt: number;
	updatedAt: number;
}

export interface LoopSnapshot {
	id: string;
	name: string;
	state: LoopState;
	iteration: number;
	maxIterations: number;
	depth: number;
	parentLoopId?: string;
	orgItemId: string;
	createdAt: number;
	updatedAt: number;
	startedAt: number;
	pausedAt?: number;
	stateBeforePause?: LoopState;
	completedAt?: number;
	currentRole: LoopRole;
	reflectEvery: number;
	taskFilePath?: string;
	taskFileHash: string;
	taskContent?: string;
	lastSummary?: string;
	changedFiles: string[];
	openFindings: string[];
	childLoopIds: string[];
	requiredChildLoopIds: string[];
	pendingChildLoopIds: string[];
	pendingGates: string[];
	gateConfigs: LoopGateConfig[];
	gateResults: GateDecision[];
	checkpoints: IterationCheckpoint[];
	handoffs: HandoffArtifact[];
	budgetLimits: LoopBudgetLimits;
	budgetStatus: LoopBudgetStatus;
	totalTreeIterations: number;
	specPaths: string[];
	domainNames: string[];
	lastProgressHash: string;
	statusReason?: string;
	autoApproveEnabled: boolean;
	reviewModelConfigured: boolean;
	gitAvailable: boolean;
	worktreePath?: string;
	manifest?: ManifestSnapshot;
}

export interface LoopListEntry {
	id: string;
	name: string;
	state: LoopState;
	iteration: number;
	maxIterations: number;
	depth: number;
	parentLoopId?: string;
	budget: LoopBudgetStatus;
	pendingHumanGates: number;
	gitAvailable: boolean;
}

export interface StartLoopOptions {
	id?: string;
	name: string;
	prompt?: string;
	taskFilePath?: string;
	taskContent?: string;
	maxIterations?: number;
	reflectEvery?: number;
	parentLoopId?: string;
	depth?: number;
	domains?: string[];
	gates?: LoopGateConfig[];
	budgetLimits?: Partial<LoopBudgetLimits>;
	specPaths?: string[];
	requiredChild?: boolean;
	failurePolicy?: LoopRetryPolicy;
	autoApproveEnabled?: boolean;
	useWorktree?: boolean;
	manifestBuilding?: boolean;
}

export interface LoopAdvanceResult {
	snapshot: LoopSnapshot;
	handoffs: HandoffArtifact[];
	gateDecisions: GateDecision[];
	childCompletions: ChildCompletionSignal[];
}

export interface LoopCommandResult {
	ok: boolean;
	message: string;
	loop?: LoopSnapshot;
}

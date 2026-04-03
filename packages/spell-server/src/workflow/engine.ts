import { DownstreamQueue, type DownstreamQueueConfig } from "./downstream";
import { WorkflowStore } from "./store";
import type {
	CheckpointEffect,
	WorkflowActor,
	WorkflowApplyActionInput,
	WorkflowApplyActionResult,
	WorkflowApprovalItem,
	WorkflowArtifactRef,
	WorkflowAuditEntry,
	WorkflowCheckpointItem,
	WorkflowClaim,
	WorkflowClaimInput,
	WorkflowCreateCheckpointInput,
	WorkflowCreateItemInput,
	WorkflowDownstreamJob,
	WorkflowItem,
	WorkflowItemFilter,
	WorkflowNotificationMessage,
	WorkflowNotificationSender,
	WorkflowReleaseClaimInput,
	WorkflowRequestRecord,
} from "./types";

export interface WorkflowEngineOptions {
	store?: WorkflowStore;
	downstreamConfig?: DownstreamQueueConfig;
	defaultClaimLeaseMs?: number;
	notificationSender?: WorkflowNotificationSender;
	now?: () => Date;
}

function isAdmin(actor: WorkflowActor): boolean {
	return actor.roles?.includes("admin") ?? false;
}

function cloneArtifacts(artifacts: WorkflowArtifactRef[]): WorkflowArtifactRef[] {
	return artifacts.map(artifact => structuredClone(artifact));
}

function applyArtifacts(
	current: WorkflowArtifactRef[],
	incoming: WorkflowArtifactRef[] | undefined,
	mode: "immutable" | "append" | "replace",
): WorkflowArtifactRef[] {
	if (!incoming || incoming.length === 0) {
		return cloneArtifacts(current);
	}
	if (mode === "immutable") {
		throw new Error("Artifacts are immutable for this action");
	}
	if (mode === "replace") {
		return cloneArtifacts(incoming);
	}
	return [...cloneArtifacts(current), ...cloneArtifacts(incoming)];
}

export class WorkflowEngine {
	#store: WorkflowStore;
	#downstreamQueue: DownstreamQueue;
	#defaultClaimLeaseMs: number;
	#notificationSender?: WorkflowNotificationSender;
	#now: () => Date;

	constructor(options: WorkflowEngineOptions = {}) {
		this.#store = options.store ?? new WorkflowStore();
		this.#defaultClaimLeaseMs = options.defaultClaimLeaseMs ?? 300_000;
		this.#notificationSender = options.notificationSender;
		this.#now = options.now ?? (() => new Date());
		this.#downstreamQueue = new DownstreamQueue({
			store: this.#store,
			now: this.#now,
			config: options.downstreamConfig,
		});
	}

	createApproval(input: WorkflowCreateItemInput): WorkflowApprovalItem {
		return this.#createItem("approval", input) as WorkflowApprovalItem;
	}

	createCheckpoint(input: WorkflowCreateCheckpointInput): WorkflowCheckpointItem {
		return this.#createItem("checkpoint", input) as WorkflowCheckpointItem;
	}

	getItem(itemId: string): WorkflowItem | undefined {
		return this.#store.getItem(itemId);
	}

	requireItem(itemId: string): WorkflowItem {
		return this.#store.requireItem(itemId);
	}

	listItems(filter: WorkflowItemFilter = {}): WorkflowItem[] {
		return this.#store.listItems(filter).map(item => this.#refreshExpiredClaim(item));
	}

	listAudit(itemId?: string): WorkflowAuditEntry[] {
		return this.#store.listAudit(itemId);
	}

	listJobs(filter: Parameters<WorkflowStore["listJobs"]>[0] = {}): WorkflowDownstreamJob[] {
		return this.#store.listJobs(filter);
	}

	getAllowedActions(itemId: string): string[] {
		const item = this.#refreshExpiredClaim(this.#store.requireItem(itemId));
		return item.actions.filter(action => action.fromStates.includes(item.state)).map(action => action.id);
	}

	claimItem(input: WorkflowClaimInput): WorkflowItem {
		const item = this.#refreshExpiredClaim(this.#store.requireItem(input.itemId));
		const currentClaim = item.claim;
		const canOverride = Boolean(input.force && isAdmin(input.actor));
		if (currentClaim && currentClaim.actor.actorId !== input.actor.actorId && !canOverride) {
			throw new Error(`Workflow item ${item.id} is already claimed by ${currentClaim.actor.actorId}`);
		}
		const timestamp = this.#now().toISOString();
		const claim = this.#buildClaim(input.actor, canOverride, item.claimLeaseMs, timestamp);
		const updated: WorkflowItem = {
			...item,
			claim,
			updatedAt: timestamp,
		};
		this.#store.saveItem(updated);
		this.#audit({
			id: this.#store.nextAuditId(),
			at: timestamp,
			kind: "claim-acquired",
			itemId: item.id,
			actor: input.actor,
			requestId: input.requestId,
			message: canOverride ? `Claim override by ${input.actor.actorId}` : `Claim acquired by ${input.actor.actorId}`,
			data: currentClaim && canOverride ? { previousActorId: currentClaim.actor.actorId } : undefined,
		});
		return updated;
	}

	releaseClaim(input: WorkflowReleaseClaimInput): WorkflowItem {
		const item = this.#refreshExpiredClaim(this.#store.requireItem(input.itemId));
		if (!item.claim) {
			return item;
		}
		const canOverride = input.force && isAdmin(input.actor);
		if (item.claim.actor.actorId !== input.actor.actorId && !canOverride) {
			throw new Error(`Workflow item ${item.id} is claimed by ${item.claim.actor.actorId}`);
		}
		const timestamp = this.#now().toISOString();
		const updated: WorkflowItem = {
			...item,
			claim: undefined,
			updatedAt: timestamp,
		};
		this.#store.saveItem(updated);
		this.#audit({
			id: this.#store.nextAuditId(),
			at: timestamp,
			kind: "claim-released",
			itemId: item.id,
			actor: input.actor,
			requestId: input.requestId,
			message: `Claim released by ${input.actor.actorId}`,
		});
		return updated;
	}

	async applyAction(input: WorkflowApplyActionInput): Promise<WorkflowApplyActionResult> {
		const duplicate = this.#store.getRequest(input.itemId, input.requestId);
		if (duplicate) {
			return {
				item: this.#refreshExpiredClaim(this.#store.requireItem(input.itemId)),
				duplicate: true,
				stale: false,
				triggeredGoals: [],
				queuedJobs: [],
			};
		}

		const item = this.#refreshExpiredClaim(this.#store.requireItem(input.itemId));
		const action = item.actions.find(candidate => candidate.id === input.actionId);
		if (!action) {
			throw new Error(`Unknown workflow action ${input.actionId} for item ${item.id}`);
		}
		if (!action.fromStates.includes(item.state)) {
			this.#recordRequest({
				requestId: input.requestId,
				itemId: item.id,
				outcome: "stale",
				at: this.#now().toISOString(),
			});
			this.#audit({
				id: this.#store.nextAuditId(),
				at: this.#now().toISOString(),
				kind: "request-stale",
				itemId: item.id,
				actor: input.actor,
				requestId: input.requestId,
				message: `Stale action ${input.actionId} ignored for state ${item.state}`,
			});
			return {
				item,
				duplicate: false,
				stale: true,
				triggeredGoals: [],
				queuedJobs: [],
			};
		}
		if (action.requiresReason && !input.reason?.trim()) {
			throw new Error(`Action ${input.actionId} requires a reason`);
		}
		this.#ensureClaim(item, input.actor, Boolean(input.force));

		const timestamp = this.#now().toISOString();
		const artifacts = applyArtifacts(item.artifacts, input.artifacts, action.artifactMode ?? "append");
		const updated = this.#applyItemTransition(item, action.toState, artifacts, timestamp, action.checkpointEffect);
		this.#store.saveItem(updated);
		this.#recordRequest({
			requestId: input.requestId,
			itemId: item.id,
			outcome: "applied",
			at: timestamp,
		});
		this.#audit({
			id: this.#store.nextAuditId(),
			at: timestamp,
			kind: "action-applied",
			itemId: item.id,
			actor: input.actor,
			requestId: input.requestId,
			message: `Applied ${input.actionId} -> ${action.toState}`,
			data: {
				actionId: input.actionId,
				toState: action.toState,
				...(input.reason ? { reason: input.reason } : {}),
			},
		});

		const queuedJobs = (action.downstreamJobs ?? []).map(spec => this.#downstreamQueue.enqueue(item.id, spec));
		const triggeredGoals: string[] = [];
		let spawnedApproval: WorkflowApprovalItem | undefined;
		if (action.checkpointEffect?.type === "trigger-goal") {
			triggeredGoals.push(action.checkpointEffect.goalName);
		}
		if (action.checkpointEffect?.type === "create-approval") {
			spawnedApproval = this.createApproval({
				...action.checkpointEffect.approval,
				linkedCheckpointId: item.id,
			});
		}
		await this.#notify(updated, input.actionId);
		return {
			item: updated,
			duplicate: false,
			stale: false,
			triggeredGoals,
			spawnedApproval,
			queuedJobs,
			effect: action.checkpointEffect,
		};
	}

	startAvailableDownstreamJobs(): WorkflowDownstreamJob[] {
		return this.#downstreamQueue.startAvailable();
	}

	markDownstreamJobSucceeded(jobId: string, artifactPath?: string): WorkflowDownstreamJob {
		return this.#downstreamQueue.markSucceeded(jobId, artifactPath);
	}

	markDownstreamJobFailed(jobId: string, error: string, retryEligible = false): WorkflowDownstreamJob {
		return this.#downstreamQueue.markFailed(jobId, error, retryEligible);
	}

	#createItem(
		kind: WorkflowItem["kind"],
		input: WorkflowCreateItemInput | WorkflowCreateCheckpointInput,
	): WorkflowItem {
		const timestamp = this.#now().toISOString();
		const item: WorkflowItem =
			kind === "approval"
				? {
						id: this.#store.nextItemId(kind),
						kind,
						workflowId: input.workflowId,
						targetId: input.targetId,
						title: input.title,
						...(input.summary !== undefined ? { summary: input.summary } : {}),
						state: input.initialState ?? "pending",
						actions: input.actions.map(action => structuredClone(action)),
						metadata: structuredClone(input.metadata ?? {}),
						artifacts: cloneArtifacts(input.artifacts ?? []),
						notificationRoutes: (input.notificationRoutes ?? []).map(route => structuredClone(route)),
						claimLeaseMs: input.claimLeaseMs ?? this.#defaultClaimLeaseMs,
						...(input.linkedGoal !== undefined ? { linkedGoal: input.linkedGoal } : {}),
						...(input.linkedRunId !== undefined ? { linkedRunId: input.linkedRunId } : {}),
						...(input.linkedCheckpointId !== undefined ? { linkedCheckpointId: input.linkedCheckpointId } : {}),
						createdAt: timestamp,
						updatedAt: timestamp,
					}
				: {
						id: this.#store.nextItemId(kind),
						kind,
						workflowId: input.workflowId,
						targetId: input.targetId,
						title: input.title,
						...(input.summary !== undefined ? { summary: input.summary } : {}),
						state: input.initialState ?? "pending",
						actions: input.actions.map(action => structuredClone(action)),
						metadata: structuredClone(input.metadata ?? {}),
						artifacts: cloneArtifacts(input.artifacts ?? []),
						notificationRoutes: (input.notificationRoutes ?? []).map(route => structuredClone(route)),
						claimLeaseMs: input.claimLeaseMs ?? this.#defaultClaimLeaseMs,
						...(input.linkedGoal !== undefined ? { linkedGoal: input.linkedGoal } : {}),
						...(input.linkedRunId !== undefined ? { linkedRunId: input.linkedRunId } : {}),
						...(input.linkedCheckpointId !== undefined ? { linkedCheckpointId: input.linkedCheckpointId } : {}),
						runStatus: (input as WorkflowCreateCheckpointInput).runStatus ?? "paused",
						createdAt: timestamp,
						updatedAt: timestamp,
					};
		this.#store.saveItem(item);
		this.#audit({
			id: this.#store.nextAuditId(),
			at: timestamp,
			kind: "item-created",
			itemId: item.id,
			message: `Created ${kind} item ${item.id}`,
		});
		return item;
	}

	#refreshExpiredClaim(item: WorkflowItem): WorkflowItem {
		if (!item.claim) return item;
		if (new Date(item.claim.expiresAt).getTime() > this.#now().getTime()) {
			return item;
		}
		const timestamp = this.#now().toISOString();
		const updated: WorkflowItem = {
			...item,
			claim: undefined,
			updatedAt: timestamp,
		};
		this.#store.saveItem(updated);
		this.#audit({
			id: this.#store.nextAuditId(),
			at: timestamp,
			kind: "claim-expired",
			itemId: item.id,
			actor: item.claim.actor,
			message: `Claim expired for ${item.claim.actor.actorId}`,
		});
		return updated;
	}

	#ensureClaim(item: WorkflowItem, actor: WorkflowActor, force: boolean): void {
		if (!item.claim) {
			throw new Error(`Workflow item ${item.id} must be claimed before mutation`);
		}
		if (item.claim.actor.actorId === actor.actorId) {
			return;
		}
		if (force && isAdmin(actor)) {
			return;
		}
		throw new Error(`Workflow item ${item.id} is claimed by ${item.claim.actor.actorId}`);
	}

	#applyItemTransition(
		item: WorkflowItem,
		toState: string,
		artifacts: WorkflowArtifactRef[],
		timestamp: string,
		effect?: CheckpointEffect,
	): WorkflowItem {
		if (item.kind === "checkpoint") {
			const runStatus =
				effect?.type === "resume-run" ? "resumed" : effect?.type === "fail-run" ? "failed" : item.runStatus;
			return {
				...item,
				state: toState,
				artifacts,
				claim: undefined,
				runStatus,
				updatedAt: timestamp,
				completedAt: timestamp,
			};
		}
		return {
			...item,
			state: toState,
			artifacts,
			claim: undefined,
			updatedAt: timestamp,
			completedAt: timestamp,
		};
	}

	#buildClaim(actor: WorkflowActor, override: boolean, claimLeaseMs: number, timestamp: string): WorkflowClaim {
		return {
			actor: structuredClone(actor),
			acquiredAt: timestamp,
			expiresAt: new Date(new Date(timestamp).getTime() + claimLeaseMs).toISOString(),
			override,
		};
	}

	#recordRequest(record: WorkflowRequestRecord): void {
		this.#store.recordRequest(record);
	}

	#audit(entry: WorkflowAuditEntry): void {
		this.#store.appendAudit(entry);
	}

	async #notify(item: WorkflowItem, actionId: string): Promise<void> {
		if (!this.#notificationSender) {
			return;
		}
		for (const route of item.notificationRoutes) {
			const message: WorkflowNotificationMessage = { item, actionId, route };
			try {
				await this.#notificationSender.send(message);
			} catch (error) {
				this.#audit({
					id: this.#store.nextAuditId(),
					at: this.#now().toISOString(),
					kind: "notification-failed",
					itemId: item.id,
					message: `Notification failed for ${route.channel}:${route.target}`,
					data: { error: error instanceof Error ? error.message : String(error) },
				});
			}
		}
	}
}

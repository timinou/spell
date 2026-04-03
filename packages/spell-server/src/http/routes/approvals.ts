import type { WorkflowEngine } from "../../workflow/engine";
import type {
	WorkflowActor,
	WorkflowApplyActionInput,
	WorkflowClaimInput,
	WorkflowCreateCheckpointInput,
	WorkflowCreateItemInput,
	WorkflowItem,
	WorkflowReleaseClaimInput,
	WorkflowValue,
} from "../../workflow/types";
import type { ApprovalDetail, ApprovalListEntry, DownstreamJobEntry } from "../types";

type WorkflowCreatePayload = (WorkflowCreateItemInput | WorkflowCreateCheckpointInput) & {
	kind: "approval" | "checkpoint";
};

function toEntry(engine: WorkflowEngine, item: WorkflowItem): ApprovalListEntry {
	return {
		id: item.id,
		kind: item.kind,
		workflowId: item.workflowId,
		targetId: item.targetId,
		title: item.title,
		state: item.state,
		allowedActions: engine.getAllowedActions(item.id),
		...(item.claim
			? {
					claim: {
						actorId: item.claim.actor.actorId,
						expiresAt: item.claim.expiresAt,
					},
				}
			: {}),
		updatedAt: item.updatedAt,
		artifactCount: item.artifacts.length,
		...(item.linkedGoal ? { linkedGoal: item.linkedGoal } : {}),
		...(item.linkedRunId ? { linkedRunId: item.linkedRunId } : {}),
	};
}

function toJobEntry(job: ReturnType<WorkflowEngine["listJobs"]>[number]): DownstreamJobEntry {
	return {
		id: job.id,
		itemId: job.itemId,
		kind: job.kind,
		status: job.status,
		retryEligible: job.retryEligible,
		attempts: job.attempts.map(attempt => ({ ...attempt })),
		updatedAt: job.updatedAt,
	};
}

async function parseJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		throw new Error("Invalid JSON body");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function invalidPayload(message: string): never {
	throw new Error(message);
}

function parseString(value: unknown, message: string): string {
	if (typeof value !== "string") {
		return invalidPayload(message);
	}
	return value;
}

function parseOptionalString(value: unknown, message: string): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		return invalidPayload(message);
	}
	return value;
}

function parseOptionalBoolean(value: unknown, message: string): boolean | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "boolean") {
		return invalidPayload(message);
	}
	return value;
}

function parseOptionalFiniteNumber(value: unknown, message: string): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return invalidPayload(message);
	}
	return value;
}

function parseStringArray(value: unknown, message: string): string[] {
	if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
		return invalidPayload(message);
	}
	return [...value];
}

function parseWorkflowValue(value: unknown, message: string): WorkflowValue {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((item, index) => parseWorkflowValue(item, `${message}[${index}]`));
	}
	if (!isRecord(value)) {
		return invalidPayload(message);
	}
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, parseWorkflowValue(item, `${message}.${key}`)]),
	);
}

function parseMetadata(value: unknown, message: string): Record<string, WorkflowValue> | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)) {
		return invalidPayload(message);
	}
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, parseWorkflowValue(item, `${message}.${key}`)]),
	);
}

function parseArtifacts(value: unknown, message: string): WorkflowCreatePayload["artifacts"] {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		return invalidPayload(`${message} must be an array`);
	}
	return value.map((artifact, index) => parseArtifactRef(artifact, `${message}[${index}]`));
}

function parseArtifactRef(value: unknown, message: string) {
	if (!isRecord(value)) {
		return invalidPayload(`${message} must be an object`);
	}
	const mediaType = parseOptionalString(value.mediaType, `${message}.mediaType must be a string`);
	const supersedes =
		value.supersedes === undefined
			? undefined
			: parseStringArray(value.supersedes, `${message}.supersedes must be an array of strings`);
	return {
		id: parseString(value.id, `${message}.id must be a string`),
		label: parseString(value.label, `${message}.label must be a string`),
		path: parseString(value.path, `${message}.path must be a string`),
		...(mediaType !== undefined ? { mediaType } : {}),
		...(supersedes !== undefined ? { supersedes } : {}),
	};
}

function parseNotificationRoutes(value: unknown, message: string): WorkflowCreatePayload["notificationRoutes"] {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		return invalidPayload(`${message} must be an array`);
	}
	return value.map((route, index) => {
		const routeMessage = `${message}[${index}]`;
		if (!isRecord(route)) {
			return invalidPayload(`${routeMessage} must be an object`);
		}
		const channel = parseString(route.channel, `${routeMessage}.channel must be a string`);
		if (channel !== "telegram" && channel !== "generic") {
			return invalidPayload(`${routeMessage}.channel must be \"telegram\" or \"generic\"`);
		}
		const template = parseOptionalString(route.template, `${routeMessage}.template must be a string`);
		return {
			channel,
			target: parseString(route.target, `${routeMessage}.target must be a string`),
			...(template !== undefined ? { template } : {}),
		};
	});
}

function parseDownstreamJobs(value: unknown, message: string) {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		return invalidPayload(`${message} must be an array`);
	}
	return value.map((job, index) => {
		const jobMessage = `${message}[${index}]`;
		if (!isRecord(job)) {
			return invalidPayload(`${jobMessage} must be an object`);
		}
		const retryEligible = parseOptionalBoolean(job.retryEligible, `${jobMessage}.retryEligible must be a boolean`);
		const payload = parseMetadata(job.payload, `${jobMessage}.payload must be an object`);
		return {
			kind: parseString(job.kind, `${jobMessage}.kind must be a string`),
			...(payload !== undefined ? { payload } : {}),
			...(retryEligible !== undefined ? { retryEligible } : {}),
		};
	});
}

function parseCheckpointEffect(value: unknown, message: string) {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)) {
		return invalidPayload(`${message} must be an object`);
	}
	const type = parseString(value.type, `${message}.type must be a string`);
	if (type === "resume-run" || type === "fail-run") {
		return { type };
	}
	if (type === "trigger-goal") {
		return { type, goalName: parseString(value.goalName, `${message}.goalName must be a string`) };
	}
	if (type === "create-approval") {
		if (!isRecord(value.approval)) {
			return invalidPayload(`${message}.approval must be an object`);
		}
		return { type, approval: parseSpawnApprovalTemplate(value.approval, `${message}.approval`) };
	}
	return invalidPayload(`${message}.type is invalid`);
}

function parseActionDefinition(value: unknown, message: string) {
	if (!isRecord(value)) {
		return invalidPayload(`${message} must be an object`);
	}
	const requiresReason = parseOptionalBoolean(value.requiresReason, `${message}.requiresReason must be a boolean`);
	const artifactMode = parseOptionalString(value.artifactMode, `${message}.artifactMode must be a string`);
	if (
		artifactMode !== undefined &&
		artifactMode !== "immutable" &&
		artifactMode !== "append" &&
		artifactMode !== "replace"
	) {
		return invalidPayload(`${message}.artifactMode is invalid`);
	}
	const downstreamJobs = parseDownstreamJobs(value.downstreamJobs, `${message}.downstreamJobs`);
	const checkpointEffect = parseCheckpointEffect(value.checkpointEffect, `${message}.checkpointEffect`);
	return {
		id: parseString(value.id, `${message}.id must be a string`),
		label: parseString(value.label, `${message}.label must be a string`),
		fromStates: parseStringArray(value.fromStates, `${message}.fromStates must be an array of strings`),
		toState: parseString(value.toState, `${message}.toState must be a string`),
		...(requiresReason !== undefined ? { requiresReason } : {}),
		...(artifactMode !== undefined ? { artifactMode } : {}),
		...(downstreamJobs !== undefined ? { downstreamJobs } : {}),
		...(checkpointEffect !== undefined ? { checkpointEffect } : {}),
	};
}

function parseActions(value: unknown, message: string) {
	if (!Array.isArray(value)) {
		return invalidPayload(`${message} must be an array`);
	}
	return value.map((action, index) => parseActionDefinition(action, `${message}[${index}]`));
}

function parseSpawnApprovalTemplate(value: Record<string, unknown>, message: string) {
	const summary = parseOptionalString(value.summary, `${message}.summary must be a string`);
	const metadata = parseMetadata(value.metadata, `${message}.metadata must be an object`);
	const artifacts = parseArtifacts(value.artifacts, `${message}.artifacts`);
	const notificationRoutes = parseNotificationRoutes(value.notificationRoutes, `${message}.notificationRoutes`);
	const claimLeaseMs = parseOptionalFiniteNumber(
		value.claimLeaseMs,
		`${message}.claimLeaseMs must be a finite number`,
	);
	if (claimLeaseMs !== undefined && claimLeaseMs < 0) {
		return invalidPayload(`${message}.claimLeaseMs must be non-negative`);
	}
	return {
		workflowId: parseString(value.workflowId, `${message}.workflowId must be a string`),
		targetId: parseString(value.targetId, `${message}.targetId must be a string`),
		title: parseString(value.title, `${message}.title must be a string`),
		actions: parseActions(value.actions, `${message}.actions`),
		...(summary !== undefined ? { summary } : {}),
		...(metadata !== undefined ? { metadata } : {}),
		...(artifacts !== undefined ? { artifacts } : {}),
		...(notificationRoutes !== undefined ? { notificationRoutes } : {}),
		...(claimLeaseMs !== undefined ? { claimLeaseMs } : {}),
	};
}

function parseActor(value: unknown): WorkflowActor {
	if (!isRecord(value) || typeof value.actorId !== "string" || typeof value.source !== "string") {
		throw new Error("Invalid actor payload");
	}
	if (
		value.roles !== undefined &&
		(!Array.isArray(value.roles) || !value.roles.every(role => typeof role === "string"))
	) {
		throw new Error("Invalid actor payload: roles must be an array of strings");
	}
	return {
		actorId: value.actorId,
		source: value.source,
		...(typeof value.displayName === "string" ? { displayName: value.displayName } : {}),
		...(value.roles !== undefined ? { roles: [...value.roles] } : {}),
	};
}

function parseCreatePayload(value: unknown): WorkflowCreatePayload {
	if (!isRecord(value)) {
		throw new Error("Invalid create payload");
	}
	const summary = parseOptionalString(value.summary, "Invalid create payload: summary must be a string");
	const initialState = parseOptionalString(
		value.initialState,
		"Invalid create payload: initialState must be a string",
	);
	const metadata = parseMetadata(value.metadata, "Invalid create payload: metadata must be an object");
	const artifacts = parseArtifacts(value.artifacts, "Invalid create payload: artifacts");
	const notificationRoutes = parseNotificationRoutes(
		value.notificationRoutes,
		"Invalid create payload: notificationRoutes",
	);
	const claimLeaseMs = parseOptionalFiniteNumber(
		value.claimLeaseMs,
		"Invalid create payload: claimLeaseMs must be a finite number",
	);
	if (claimLeaseMs !== undefined && claimLeaseMs < 0) {
		return invalidPayload("Invalid create payload: claimLeaseMs must be non-negative");
	}
	const linkedGoal = parseOptionalString(value.linkedGoal, "Invalid create payload: linkedGoal must be a string");
	const linkedRunId = parseOptionalString(value.linkedRunId, "Invalid create payload: linkedRunId must be a string");
	const linkedCheckpointId = parseOptionalString(
		value.linkedCheckpointId,
		"Invalid create payload: linkedCheckpointId must be a string",
	);
	const kind = parseString(value.kind, "Invalid create payload: kind must be a string");
	if (kind !== "approval" && kind !== "checkpoint") {
		return invalidPayload('Invalid create payload: kind must be "approval" or "checkpoint"');
	}
	const basePayload = {
		kind,
		workflowId: parseString(value.workflowId, "Invalid create payload: workflowId must be a string"),
		targetId: parseString(value.targetId, "Invalid create payload: targetId must be a string"),
		title: parseString(value.title, "Invalid create payload: title must be a string"),
		actions: parseActions(value.actions, "Invalid create payload: actions"),
		...(summary !== undefined ? { summary } : {}),
		...(initialState !== undefined ? { initialState } : {}),
		...(metadata !== undefined ? { metadata } : {}),
		...(artifacts !== undefined ? { artifacts } : {}),
		...(notificationRoutes !== undefined ? { notificationRoutes } : {}),
		...(claimLeaseMs !== undefined ? { claimLeaseMs } : {}),
		...(linkedGoal !== undefined ? { linkedGoal } : {}),
		...(linkedRunId !== undefined ? { linkedRunId } : {}),
		...(linkedCheckpointId !== undefined ? { linkedCheckpointId } : {}),
	};
	if (kind === "checkpoint") {
		const runStatus = parseOptionalString(value.runStatus, "Invalid create payload: runStatus must be a string");
		if (runStatus !== undefined && runStatus !== "paused" && runStatus !== "resumed" && runStatus !== "failed") {
			return invalidPayload("Invalid create payload: runStatus is invalid");
		}
		return {
			...basePayload,
			kind,
			...(runStatus !== undefined ? { runStatus } : {}),
		};
	}
	return basePayload;
}

function parseClaimPayload(itemId: string, value: unknown): WorkflowClaimInput {
	if (!isRecord(value) || typeof value.requestId !== "string") {
		throw new Error("Invalid claim payload");
	}
	return {
		itemId,
		actor: parseActor(value.actor),
		requestId: value.requestId,
		...(typeof value.force === "boolean" ? { force: value.force } : {}),
	};
}

function parseReleasePayload(itemId: string, value: unknown): WorkflowReleaseClaimInput {
	if (!isRecord(value) || typeof value.requestId !== "string") {
		throw new Error("Invalid release payload");
	}
	return {
		itemId,
		actor: parseActor(value.actor),
		requestId: value.requestId,
		...(typeof value.force === "boolean" ? { force: value.force } : {}),
	};
}

function parseActionPayload(itemId: string, value: unknown): WorkflowApplyActionInput {
	if (!isRecord(value) || typeof value.requestId !== "string" || typeof value.actionId !== "string") {
		throw new Error("Invalid action payload");
	}
	const reason = parseOptionalString(value.reason, "Invalid action payload: reason must be a string");
	const artifacts = parseArtifacts(value.artifacts, "Invalid action payload: artifacts");
	const force = parseOptionalBoolean(value.force, "Invalid action payload: force must be a boolean");
	return {
		itemId,
		actionId: value.actionId,
		actor: parseActor(value.actor),
		requestId: value.requestId,
		...(reason !== undefined ? { reason } : {}),
		...(artifacts !== undefined ? { artifacts } : {}),
		...(force !== undefined ? { force } : {}),
	};
}

export function handleListApprovals(request: Request, engine: WorkflowEngine): Response {
	const url = new URL(request.url);
	const kind = url.searchParams.get("kind");
	const state = url.searchParams.get("state");
	const items = engine.listItems({
		...(kind === "approval" || kind === "checkpoint" ? { kind } : {}),
		...(state ? { state } : {}),
	});
	return Response.json(items.map(item => toEntry(engine, item)));
}

export function handleGetApproval(itemId: string, engine: WorkflowEngine): Response {
	const item = engine.getItem(itemId);
	if (!item) {
		return Response.json({ error: "Approval not found" }, { status: 404 });
	}
	const detail: ApprovalDetail = {
		...toEntry(engine, item),
		...(item.summary ? { summary: item.summary } : {}),
		metadata: structuredClone(item.metadata),
		artifacts: item.artifacts.map(artifact => ({ ...artifact })),
		audit: engine.listAudit(item.id),
		downstreamJobs: engine.listJobs({ itemId: item.id }).map(job => toJobEntry(job)),
	};
	return Response.json(detail);
}

export async function handleCreateApproval(request: Request, engine: WorkflowEngine): Promise<Response> {
	const payload = parseCreatePayload(await parseJson(request));
	const item = payload.kind === "checkpoint" ? engine.createCheckpoint(payload) : engine.createApproval(payload);
	return Response.json(toEntry(engine, item), { status: 201 });
}

export async function handleClaimApproval(itemId: string, request: Request, engine: WorkflowEngine): Promise<Response> {
	const item = engine.claimItem(parseClaimPayload(itemId, await parseJson(request)));
	return Response.json(toEntry(engine, item));
}

export async function handleReleaseApprovalClaim(
	itemId: string,
	request: Request,
	engine: WorkflowEngine,
): Promise<Response> {
	const item = engine.releaseClaim(parseReleasePayload(itemId, await parseJson(request)));
	return Response.json(toEntry(engine, item));
}

export async function handleApplyApprovalAction(
	itemId: string,
	request: Request,
	engine: WorkflowEngine,
): Promise<Response> {
	const result = await engine.applyAction(parseActionPayload(itemId, await parseJson(request)));
	return Response.json({
		item: toEntry(engine, result.item),
		duplicate: result.duplicate,
		stale: result.stale,
		triggeredGoals: result.triggeredGoals,
		spawnedApproval: result.spawnedApproval ? toEntry(engine, result.spawnedApproval) : undefined,
		queuedJobs: result.queuedJobs.map(job => toJobEntry(job)),
	});
}

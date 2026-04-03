import type { WorkflowEngine } from "../../workflow/engine";
import type {
	WorkflowActor,
	WorkflowApplyActionInput,
	WorkflowClaimInput,
	WorkflowCreateCheckpointInput,
	WorkflowCreateItemInput,
	WorkflowItem,
	WorkflowReleaseClaimInput,
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

function parseActor(value: unknown): WorkflowActor {
	if (!isRecord(value) || typeof value.actorId !== "string" || typeof value.source !== "string") {
		throw new Error("Invalid actor payload");
	}
	return {
		actorId: value.actorId,
		source: value.source,
		...(typeof value.displayName === "string" ? { displayName: value.displayName } : {}),
		...(Array.isArray(value.roles)
			? { roles: value.roles.filter(role => typeof role === "string") as string[] }
			: {}),
	};
}

function parseCreatePayload(value: unknown): WorkflowCreatePayload {
	if (!isRecord(value)) {
		throw new Error("Invalid create payload");
	}
	if (
		typeof value.kind !== "string" ||
		(value.kind !== "approval" && value.kind !== "checkpoint") ||
		typeof value.workflowId !== "string" ||
		typeof value.targetId !== "string" ||
		typeof value.title !== "string" ||
		!Array.isArray(value.actions)
	) {
		throw new Error("Invalid create payload");
	}
	return value as unknown as WorkflowCreatePayload;
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
	return {
		itemId,
		actionId: value.actionId,
		actor: parseActor(value.actor),
		requestId: value.requestId,
		...(typeof value.reason === "string" ? { reason: value.reason } : {}),
		...(Array.isArray(value.artifacts)
			? { artifacts: value.artifacts as WorkflowApplyActionInput["artifacts"] }
			: {}),
		...(typeof value.force === "boolean" ? { force: value.force } : {}),
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

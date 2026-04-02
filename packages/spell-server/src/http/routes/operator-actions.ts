export type OperatorActionSource = "telegram" | "review-queue";
export type OperatorApprovalAction = "approve-feed" | "approve-publication" | "reject" | "defer";

export interface OperatorActionActor {
	userId: string;
	chatId?: number;
	messageId?: number;
}

interface OperatorActionRequestBase {
	source: OperatorActionSource;
	requestId: string;
	articleId: string;
	action: OperatorApprovalAction;
}

export type OperatorActionRequest =
|	(OperatorActionRequestBase & {
		source: "telegram";
		actor: OperatorActionActor & { chatId: number };
	})
|	(OperatorActionRequestBase & {
		source: "review-queue";
		actor: OperatorActionActor;
	});

export interface OperatorActionDownstreamJob {
	jobId: string;
	kind: "feed-delivery" | "publication-export";
	status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
	retryEligible: boolean;
}

export interface OperatorActionResult {
	articleId: string;
	workflowState: string;
	triggeredGoals: string[];
	duplicate: boolean;
	downstreamJobs: OperatorActionDownstreamJob[];
}

export type OperatorActionHandler = (
	request: OperatorActionRequest,
) => Promise<OperatorActionResult> | OperatorActionResult;

const VALID_SOURCES = new Set<OperatorActionSource>(["telegram", "review-queue"]);
const VALID_ACTIONS = new Set<OperatorApprovalAction>(["approve-feed", "approve-publication", "reject", "defer"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseOperatorActionRequest(value: unknown): OperatorActionRequest | null {
	if (!isRecord(value)) {
		return null;
	}
	if (typeof value.source !== "string" || !VALID_SOURCES.has(value.source as OperatorActionSource)) {
		return null;
	}
	if (typeof value.requestId !== "string" || value.requestId.length === 0) {
		return null;
	}
	if (typeof value.articleId !== "string" || value.articleId.length === 0) {
		return null;
	}
	if (typeof value.action !== "string" || !VALID_ACTIONS.has(value.action as OperatorApprovalAction)) {
		return null;
	}
	if (!isRecord(value.actor)) {
		return null;
	}
	if (typeof value.actor.userId !== "string" || value.actor.userId.length === 0) {
		return null;
	}
	if (value.actor.chatId !== undefined && (typeof value.actor.chatId !== "number" || !Number.isFinite(value.actor.chatId))) {
		return null;
	}
	if (
		value.actor.messageId !== undefined &&
		(typeof value.actor.messageId !== "number" || !Number.isFinite(value.actor.messageId))
	) {
		return null;
	}

	const actor = {
		userId: value.actor.userId,
		...(value.actor.chatId !== undefined ? { chatId: value.actor.chatId } : {}),
		...(value.actor.messageId !== undefined ? { messageId: value.actor.messageId } : {}),
	} satisfies OperatorActionActor;

	if (value.source === "telegram") {
		if (actor.chatId === undefined) {
			return null;
		}
		return {
			source: "telegram",
			requestId: value.requestId,
			articleId: value.articleId,
			action: value.action as OperatorApprovalAction,
			actor: {
				userId: actor.userId,
				chatId: actor.chatId,
				...(actor.messageId !== undefined ? { messageId: actor.messageId } : {}),
			},
		};
	}

	return {
		source: "review-queue",
		requestId: value.requestId,
		articleId: value.articleId,
		action: value.action as OperatorApprovalAction,
		actor,
	};
}

export async function handleOperatorActionsRoute(request: Request, handler?: OperatorActionHandler): Promise<Response> {
	if (request.method !== "POST") {
		return Response.json({ error: "Method not allowed" }, { status: 405 });
	}
	if (!handler) {
		return Response.json({ error: "Operator actions are not configured" }, { status: 501 });
	}

	let payload: unknown;
	try {
		payload = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const actionRequest = parseOperatorActionRequest(payload);
	if (!actionRequest) {
		return Response.json({ error: "Invalid operator action payload" }, { status: 400 });
	}

	const result = await handler(actionRequest);
	return Response.json(result);
}

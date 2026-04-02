export type OperatorApprovalAction = "approve-feed" | "approve-publication" | "reject" | "defer";

export interface OperatorActionRequest {
  source: "telegram";
  callbackId: string;
  articleId: string;
  action: OperatorApprovalAction;
  actor: {
    userId: string;
    chatId: number;
    messageId?: number;
  };
}

export interface OperatorActionResult {
  articleId: string;
  workflowState: string;
  triggeredGoals: string[];
  duplicate: boolean;
}

export type OperatorActionHandler = (
  request: OperatorActionRequest,
) => Promise<OperatorActionResult> | OperatorActionResult;

const VALID_ACTIONS = new Set<OperatorApprovalAction>([
  "approve-feed",
  "approve-publication",
  "reject",
  "defer",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseOperatorActionRequest(value: unknown): OperatorActionRequest | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.source !== "telegram") {
    return null;
  }
  if (typeof value.callbackId !== "string" || value.callbackId.length === 0) {
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
  if (typeof value.actor.chatId !== "number" || !Number.isFinite(value.actor.chatId)) {
    return null;
  }
  if (
    value.actor.messageId !== undefined &&
    (typeof value.actor.messageId !== "number" || !Number.isFinite(value.actor.messageId))
  ) {
    return null;
  }

  return {
    source: "telegram",
    callbackId: value.callbackId,
    articleId: value.articleId,
    action: value.action,
    actor: {
      userId: value.actor.userId,
      chatId: value.actor.chatId,
      ...(value.actor.messageId !== undefined ? { messageId: value.actor.messageId } : {}),
    },
  };
}

export async function handleOperatorActionsRoute(
  request: Request,
  handler?: OperatorActionHandler,
): Promise<Response> {
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

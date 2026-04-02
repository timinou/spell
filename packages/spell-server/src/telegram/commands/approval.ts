import type { OperatorActionHandler, OperatorApprovalAction } from "../../http/routes/operator-actions";
import type { AuthContext } from "../bot/auth";
import type { TelegramBot } from "../bot/bot";
import { type CommandContext, resolveChatId } from "./index";

const APPROVAL_CALLBACK_PREFIX = "approval:";
const ACTION_TO_CODE: Record<OperatorApprovalAction, string> = {
    "approve-feed": "af",
    "approve-publication": "ap",
    reject: "r",
    defer: "d",
};
const CODE_TO_ACTION = new Map<string, OperatorApprovalAction>(
    Object.entries(ACTION_TO_CODE).map(([action, code]) => [code, action as OperatorApprovalAction]),
);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ParsedApprovalCallback {
    action: OperatorApprovalAction;
    articleId: string;
    requestId: string;
}

function formatActionLabel(action: OperatorApprovalAction): string {
    switch (action) {
        case "approve-feed":
            return "Approved for feed";
        case "approve-publication":
            return "Approved for publication";
        case "reject":
            return "Rejected";
        case "defer":
            return "Deferred";
    }
}

function encodeArticleToken(articleId: string): string {
    if (UUID_PATTERN.test(articleId)) {
        return `u${Buffer.from(articleId.replaceAll("-", ""), "hex").toString("base64url")}`;
    }

    return `s${Buffer.from(articleId, "utf8").toString("base64url")}`;
}

function decodeArticleToken(articleToken: string): string | null {
    const kind = articleToken[0];
    const payload = articleToken.slice(1);
    if (!kind || payload.length === 0) {
        return null;
    }

    try {
        const decoded = Buffer.from(payload, "base64url");
        if (kind === "u") {
            if (decoded.length !== 16) {
                return null;
            }

            const hex = decoded.toString("hex");
            return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        }

        if (kind === "s") {
            return decoded.toString("utf8");
        }

        return null;
    } catch {
        return null;
    }
}

async function safeEditMessage(ctx: AuthContext, text: string): Promise<void> {
    try {
        await ctx.editMessageText(text);
    } catch {
        await ctx.reply(text);
    }
}

export function buildApprovalCallbackData(input: ParsedApprovalCallback): string {
    const actionCode = ACTION_TO_CODE[input.action];
    const callbackData = `${APPROVAL_CALLBACK_PREFIX}${actionCode}:${encodeArticleToken(input.articleId)}:${input.requestId}`;
    if (callbackData.length > 64) {
        throw new Error(`Approval callback data exceeds Telegram's 64 byte limit for article ${input.articleId}`);
    }
    return callbackData;
}

export function parseApprovalCallbackData(value: string): ParsedApprovalCallback | null {
    const match = /^approval:(af|ap|r|d):([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/i.exec(value.trim());
    if (!match) {
        return null;
    }

    const action = CODE_TO_ACTION.get((match[1] ?? "").toLowerCase());
    const articleId = decodeArticleToken(match[2] ?? "");
    const requestId = match[3] ?? "";
    if (!action || !articleId || requestId.length === 0) {
        return null;
    }

    return {
        action,
        articleId,
        requestId,
    };
}

export async function handleApprovalCallback(
    ctx: AuthContext,
    cmdCtx: CommandContext,
    parsed: ParsedApprovalCallback,
    bridge: OperatorActionHandler | undefined = cmdCtx.operatorActionBridge,
): Promise<void> {
    await ctx.answerCallbackQuery();
    if (!bridge) {
        await safeEditMessage(ctx, "Approval bridge unavailable.");
        return;
    }

    const chatId = resolveChatId(ctx);
    if (!chatId) {
        await safeEditMessage(ctx, "Could not determine chat session.");
        return;
    }

    try {
        const result = await bridge({
            source: "telegram",
            requestId: parsed.requestId,
            articleId: parsed.articleId,
            action: parsed.action,
            actor: {
                userId: ctx.authState.userId,
                chatId: Number(chatId),
                messageId: ctx.callbackQuery?.message?.message_id,
            },
        });

        if (result.duplicate) {
            await safeEditMessage(ctx, `${formatActionLabel(parsed.action)} already applied.`);
            return;
        }

        const triggerSuffix = result.triggeredGoals.length > 0 ? ` Triggered: ${result.triggeredGoals.join(", ")}.` : "";
        await safeEditMessage(ctx, `${formatActionLabel(parsed.action)}.${triggerSuffix}`);
    } catch {
        await safeEditMessage(ctx, "Unable to process approval action right now.");
    }
}

export function registerApprovalCallbacks(bot: TelegramBot, cmdCtx: CommandContext): void {
    bot.callbackQuery(/^approval:(af|ap|r|d):([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/i, async ctx => {
        const data = ctx.callbackQuery.data;
        const parsed = typeof data === "string" ? parseApprovalCallbackData(data) : null;
        if (!parsed) {
            await ctx.answerCallbackQuery();
            await safeEditMessage(ctx, "Approval action unavailable.");
            return;
        }
        await handleApprovalCallback(ctx, cmdCtx, parsed);
    });
}

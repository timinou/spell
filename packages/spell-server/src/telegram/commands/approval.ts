import type { OperatorActionHandler, OperatorApprovalAction } from "../../http/routes/operator-actions";
import type { AuthContext } from "../bot/auth";
import type { TelegramBot } from "../bot/bot";
import { type CommandContext, resolveChatId } from "./index";

const APPROVAL_CALLBACK_PREFIX = "approval:";

export interface ParsedApprovalCallback {
	action: OperatorApprovalAction;
	articleId: string;
	callbackId: string;
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

async function safeEditMessage(ctx: AuthContext, text: string): Promise<void> {
	try {
		await ctx.editMessageText(text);
	} catch {
		await ctx.reply(text);
	}
}

export function buildApprovalCallbackData(input: ParsedApprovalCallback): string {
	return `${APPROVAL_CALLBACK_PREFIX}${input.action}:${input.articleId}:${input.callbackId}`;
}

export function parseApprovalCallbackData(value: string): ParsedApprovalCallback | null {
	const match = /^approval:(approve-feed|approve-publication|reject|defer):([^:]+):([^:]+)$/i.exec(value.trim());
	if (!match) {
		return null;
	}
	return {
		action: match[1] as OperatorApprovalAction,
		articleId: match[2] ?? "",
		callbackId: match[3] ?? "",
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
			callbackId: parsed.callbackId,
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
	bot.callbackQuery(/^approval:(approve-feed|approve-publication|reject|defer):([^:]+):([^:]+)$/i, async ctx => {
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

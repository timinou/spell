import { InlineKeyboard } from "grammy";
import type { AuthContext } from "../bot/auth";
import type { TelegramBot } from "../bot/bot";
import { type CommandContext, resolveChatId, respawnSession } from "./index";

const FULL_MODE = "telegram-full";
const READONLY_MODE = "telegram-readonly";
const UNLOCK_CONFIRM_CALLBACK = "unlock:confirm";
const UNLOCK_CANCEL_CALLBACK = "unlock:cancel";

async function switchToMode(ctx: AuthContext, cmdCtx: CommandContext, mode: string): Promise<"switched" | "already"> {
	const chatId = resolveChatId(ctx);
	if (!chatId) {
		throw new Error("Chat ID unavailable");
	}

	const session = cmdCtx.processManager.getSession(chatId);
	if (session?.mode === mode) {
		return "already";
	}

	await respawnSession(ctx, cmdCtx, {
		mode,
		project: session?.project,
	});
	return "switched";
}

async function safeEditMessage(ctx: AuthContext, text: string): Promise<void> {
	try {
		await ctx.editMessageText(text);
	} catch {
		await ctx.reply(text);
	}
}

export async function handleUnlockCommand(ctx: AuthContext, cmdCtx: CommandContext): Promise<void> {
	if (!ctx.authState.isOwner) {
		await ctx.reply("Not authorized");
		return;
	}

	const chatId = resolveChatId(ctx);
	if (!chatId) {
		await ctx.reply("Could not determine chat session.");
		return;
	}

	if (cmdCtx.processManager.getSession(chatId)?.mode === FULL_MODE) {
		await ctx.reply("Already in full access mode");
		return;
	}

	const keyboard = new InlineKeyboard()
		.text("Confirm", UNLOCK_CONFIRM_CALLBACK)
		.text("Cancel", UNLOCK_CANCEL_CALLBACK);
	await ctx.reply("Switch to full access mode?", { reply_markup: keyboard });
}

export async function handleLockCommand(ctx: AuthContext, cmdCtx: CommandContext): Promise<void> {
	const switched = await switchToMode(ctx, cmdCtx, READONLY_MODE);
	if (switched === "already") {
		await ctx.reply("Already in read-only mode");
		return;
	}

	await ctx.reply("Switched to read-only mode.");
}

export function registerUnlockLockCallbacks(bot: TelegramBot, cmdCtx: CommandContext): void {
	bot.callbackQuery(UNLOCK_CONFIRM_CALLBACK, async ctx => {
		await ctx.answerCallbackQuery();
		if (!ctx.authState.isOwner) {
			await safeEditMessage(ctx, "Not authorized");
			return;
		}

		try {
			const switched = await switchToMode(ctx, cmdCtx, FULL_MODE);
			if (switched === "already") {
				await safeEditMessage(ctx, "Already in full access mode");
				return;
			}
			await safeEditMessage(ctx, "Switched to full access mode.");
		} catch {
			await safeEditMessage(ctx, "Unable to switch modes right now.");
		}
	});

	bot.callbackQuery(UNLOCK_CANCEL_CALLBACK, async ctx => {
		await ctx.answerCallbackQuery();
		await safeEditMessage(ctx, "Unlock cancelled.");
	});
}

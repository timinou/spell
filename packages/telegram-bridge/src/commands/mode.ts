import { InlineKeyboard } from "grammy";
import type { AuthContext } from "../bot/auth";
import type { TelegramBot } from "../bot/bot";
import { type CommandContext, parseCommandArgument, resolveChatId, respawnSession } from "./index";

const MODE_CALLBACK_PREFIX = "mode:";

function modeKeyboard(modes: string[]): InlineKeyboard {
	const keyboard = new InlineKeyboard();
	for (const mode of modes) {
		keyboard.text(mode, `${MODE_CALLBACK_PREFIX}${mode}`).row();
	}
	return keyboard;
}

function parseModeFromCallback(match: string | RegExpMatchArray): string {
	if (Array.isArray(match)) {
		return match[1] ?? "";
	}
	if (match.startsWith(MODE_CALLBACK_PREFIX)) {
		return match.slice(MODE_CALLBACK_PREFIX.length);
	}
	return "";
}

async function switchMode(ctx: AuthContext, cmdCtx: CommandContext, mode: string): Promise<"switched" | "already"> {
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

function availableModesMessage(modes: string[]): string {
	return `Available modes: ${modes.join(", ")}`;
}

export async function handleModeCommand(ctx: AuthContext, cmdCtx: CommandContext): Promise<void> {
	const modes = ctx.authState.userConfig.modes;
	if (modes.length === 0) {
		await ctx.reply("No modes are available for your account.");
		return;
	}

	const selected = parseCommandArgument(ctx);
	if (!selected) {
		await ctx.reply("Select a mode:", {
			reply_markup: modeKeyboard(modes),
		});
		return;
	}

	if (!modes.includes(selected)) {
		await ctx.reply(`Unknown mode. ${availableModesMessage(modes)}`);
		return;
	}

	const switched = await switchMode(ctx, cmdCtx, selected);
	if (switched === "already") {
		await ctx.reply(`Already in ${selected} mode`);
		return;
	}

	await ctx.reply(`Switched to mode: ${selected}`);
}

export function registerModeCallbacks(bot: TelegramBot, cmdCtx: CommandContext): void {
	bot.callbackQuery(/^mode:(.+)$/i, async ctx => {
		await ctx.answerCallbackQuery();

		const allowedModes = ctx.authState.userConfig.modes;
		const mode = parseModeFromCallback(ctx.match);
		if (!mode || !allowedModes.includes(mode)) {
			await ctx.reply(`Mode unavailable. ${availableModesMessage(allowedModes)}`);
			return;
		}

		try {
			const switched = await switchMode(ctx, cmdCtx, mode);
			if (switched === "already") {
				await ctx.editMessageText(`Already in ${mode} mode`);
				return;
			}
			await ctx.editMessageText(`Switched to mode: ${mode}`);
		} catch {
			await ctx.reply("Unable to switch mode right now.");
		}
	});
}

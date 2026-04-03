import type { AuthContext } from "../bot/auth";
import { type CommandContext, resolveChatId } from "./index";

function formatDuration(durationMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);

	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	return `${minutes}m`;
}

export async function handleThinkCommand(ctx: AuthContext, cmdCtx: CommandContext): Promise<void> {
	const chatId = resolveChatId(ctx);
	if (!chatId) {
		await ctx.reply("Could not determine chat session.");
		return;
	}

	const session = cmdCtx.processManager.getSession(chatId);
	if (!session) {
		await ctx.reply("No active session. Send a message to start one.");
		return;
	}

	session.showThinking = !session.showThinking;
	await cmdCtx.processManager.saveState();
	await ctx.reply(`Thinking is now ${session.showThinking ? "visible" : "hidden"}.`);
}

export async function handleClearCommand(ctx: AuthContext, cmdCtx: CommandContext): Promise<void> {
	const chatId = resolveChatId(ctx);
	if (!chatId) {
		await ctx.reply("Could not determine chat session.");
		return;
	}

	const client = cmdCtx.processManager.get(chatId);
	if (!client) {
		await ctx.reply("No active session");
		return;
	}

	try {
		client.send({ type: "new_session" });
		const session = cmdCtx.processManager.getSession(chatId);
		if (session) {
			session.voiceReplyOverride = undefined;
			await cmdCtx.processManager.saveState();
		}
		await ctx.reply("Started a new session.");
	} catch (error) {
		await ctx.reply(`Failed to clear session: ${String(error)}`);
	}
}

export async function handleStatusCommand(ctx: AuthContext, cmdCtx: CommandContext): Promise<void> {
	const chatId = resolveChatId(ctx);
	if (!chatId) {
		await ctx.reply("No active session. Send a message to start one.");
		return;
	}

	const session = cmdCtx.processManager.getSession(chatId);
	if (!session) {
		await ctx.reply("No active session. Send a message to start one.");
		return;
	}

	const uptime = formatDuration(Date.now() - session.createdAt);
	const statusLines = [
		`Project: ${session.project}`,
		`Mode: ${session.mode}`,
		`Session: active (${uptime})`,
		`Thinking: ${session.showThinking ? "visible" : "hidden"}`,
		`Voice: ${session.voiceReplyOverride ?? "default"}`,
	];

	await ctx.reply(statusLines.join("\n"));
}

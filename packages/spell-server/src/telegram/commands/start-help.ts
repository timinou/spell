import type { AuthContext } from "../bot/auth";
import { COMMANDS, type CommandContext } from "./index";

export async function handleStartCommand(ctx: AuthContext, _cmdCtx: CommandContext): Promise<void> {
	if (ctx.authState.isOwner) {
		await ctx.reply("Authorized. Send a message to start a session.");
		return;
	}

	await ctx.reply("Temporary access granted. You can now send prompts.");
}

export async function handleHelpCommand(ctx: AuthContext, _cmdCtx: CommandContext): Promise<void> {
	const lines = ["Available commands:", ""];
	for (const command of COMMANDS) {
		lines.push(`/${command.command} — ${command.description}`);
	}
	await ctx.reply(lines.join("\n"));
}

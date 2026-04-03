import type { VoiceReplyMode } from "../../config/types";
import type { AuthContext } from "../bot/auth";
import { type CommandContext, parseCommandArgument, resolveChatId } from "./index";

const VOICE_MODES: VoiceReplyMode[] = ["never", "mirror", "always"];

export async function handleVoiceCommand(ctx: AuthContext, cmdCtx: CommandContext): Promise<void> {
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

	const arg = parseCommandArgument(ctx).toLowerCase();

	if (arg === "status") {
		const effective = session.voiceReplyOverride ?? cmdCtx.config.voice?.replyMode ?? "mirror";
		const source = session.voiceReplyOverride ? "session" : "config";
		await ctx.reply(`Voice reply mode: ${effective} (${source})`);
		return;
	}

	if (arg === "on") {
		session.voiceReplyOverride = "always";
	} else if (arg === "off") {
		session.voiceReplyOverride = "never";
	} else if (arg === "mirror") {
		session.voiceReplyOverride = "mirror";
	} else {
		const current = session.voiceReplyOverride ?? "never";
		const currentIndex = VOICE_MODES.indexOf(current);
		session.voiceReplyOverride = VOICE_MODES[(currentIndex + 1) % VOICE_MODES.length]!;
	}

	await cmdCtx.processManager.saveState();
	await ctx.reply(`Voice reply mode: ${session.voiceReplyOverride}`);
}

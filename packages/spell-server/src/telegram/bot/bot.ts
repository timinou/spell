import { logger } from "@oh-my-pi/pi-utils";
import { Bot, type Context, type MiddlewareFn } from "grammy";
import type { OperatorActionHandler } from "../../http/routes/operator-actions";
import type { RpcEvent } from "../../rpc/types";
import { awaitStreamerCompletion, ResponseStreamer, resolveVoiceReply } from "../bridge/rpc-to-telegram";
import { handleTelegramMessage } from "../bridge/telegram-to-rpc";
import {
	type CommandContext,
	registerCommands,
	resolveChatId,
	resolveDefaultProject,
	resolveModeTools,
} from "../commands";
import { handleBtwCommand } from "../commands/btw";
import { handleModeCommand } from "../commands/mode";
import { handleProjectCommand } from "../commands/project";
import { handleClearCommand, handleStatusCommand, handleThinkCommand } from "../commands/session-commands";
import { handleHelpCommand, handleStartCommand } from "../commands/start-help";
import { handleLockCommand, handleUnlockCommand } from "../commands/unlock-lock";
import { handleVoiceCommand } from "../commands/voice";
import type { ProcessManager } from "../process-manager";
import type { TelegramBridgeConfig } from "../types";
import { createSttProvider, createTtsProvider, type SttProvider, type TtsProvider } from "../voice";
import { type AuthContext, authMiddleware } from "./auth";
import { handleInviteCommand } from "./invite";
import { TokenStore } from "./tokens";

export type TelegramBot = Bot<AuthContext>;

type ShutdownSignal = "SIGINT" | "SIGTERM";

function getCommandName(ctx: Context, botUsername: string): string | null {
	const text = ctx.message?.text?.trim();
	if (!text || !text.startsWith("/")) {
		return null;
	}
	const firstSegment = text.split(/\s+/, 1)[0] ?? "";
	const withoutSlash = firstSegment.startsWith("/") ? firstSegment.slice(1) : firstSegment;
	if (!withoutSlash) {
		return null;
	}

	const parts = withoutSlash.split("@", 2);
	const commandName = parts[0]?.toLowerCase();
	const targetBot = parts[1]?.toLowerCase();
	if (!commandName) {
		return null;
	}
	if (targetBot && botUsername && targetBot !== botUsername.toLowerCase()) {
		return null;
	}
	return commandName;
}

export function createCommandRouter(
	tokenStore: TokenStore,
	botUsername: string,
	cmdCtx: CommandContext,
): MiddlewareFn<AuthContext> {
	return async (ctx, next) => {
		const commandName = getCommandName(ctx, botUsername);
		if (!commandName) {
			await next();
			return;
		}

		switch (commandName) {
			case "start":
				await handleStartCommand(ctx, cmdCtx);
				return;
			case "help":
				await handleHelpCommand(ctx, cmdCtx);
				return;
			case "unlock":
				await handleUnlockCommand(ctx, cmdCtx);
				return;
			case "lock":
				await handleLockCommand(ctx, cmdCtx);
				return;
			case "project":
				await handleProjectCommand(ctx, cmdCtx);
				return;
			case "mode":
				await handleModeCommand(ctx, cmdCtx);
				return;
			case "think":
				await handleThinkCommand(ctx, cmdCtx);
				return;
			case "clear":
				await handleClearCommand(ctx, cmdCtx);
				return;
			case "status":
				await handleStatusCommand(ctx, cmdCtx);
				return;
			case "btw":
				await handleBtwCommand(ctx, cmdCtx);
				return;
			case "voice":
				await handleVoiceCommand(ctx, cmdCtx);
				return;
			case "invite": {
				if (!ctx.authState.isOwner) {
					await ctx.reply("Not authorized");
					return;
				}
				if (!botUsername) {
					await ctx.reply("Bot username is unavailable. Set a public username to use /invite.");
					return;
				}
				await handleInviteCommand(ctx, tokenStore, botUsername);
				return;
			}
			default:
				await next();
		}
	};
}

export function createMessageHandler(cmdCtx: CommandContext): MiddlewareFn<AuthContext> {
	return async (ctx, next) => {
		const message = ctx.message;
		if (!message) {
			await next();
			return;
		}

		const text = "text" in message ? message.text : undefined;
		if (text?.startsWith("/")) {
			await next();
			return;
		}

		const hasPhoto = "photo" in message && Array.isArray(message.photo) && message.photo.length > 0;
		const hasDocument = "document" in message && Boolean(message.document);
		const hasVoice = "voice" in message && Boolean(message.voice);
		const hasVideoNote = "video_note" in message && Boolean(message.video_note);
		const hasAudio = "audio" in message && Boolean(message.audio);
		if (!text && !hasPhoto && !hasDocument && !hasVoice && !hasVideoNote && !hasAudio) {
			await next();
			return;
		}

		const chatId = resolveChatId(ctx);
		if (!chatId) {
			await ctx.reply("Could not determine chat session.");
			return;
		}

		const existingSession = cmdCtx.processManager.getSession(chatId);
		const project = existingSession?.project ?? resolveDefaultProject(cmdCtx.config);
		const mode = existingSession?.mode ?? ctx.authState.userConfig.defaultMode;
		const tools = resolveModeTools(mode);

		logger.debug("Received Telegram prompt", {
			chatId,
			userId: ctx.authState.userId,
			messageLength: text?.length ?? 0,
			hasVoice,
			hasVideoNote,
			hasAudio,
		});

		try {
			const client = await cmdCtx.processManager.getOrCreate(chatId, ctx.authState.userId, {
				project,
				mode,
				tools,
				appendSystemPrompt: cmdCtx.telegramPrompt,
				sessionPath: existingSession?.sessionPath,
			});

			const session = cmdCtx.processManager.getSession(chatId);
			const incomingWasVoice = hasVoice || hasVideoNote || hasAudio;
			const voiceReplyDecision = cmdCtx.config.voice
				? resolveVoiceReply({
						globalMode: cmdCtx.config.voice.replyMode,
						userMode: cmdCtx.config.users[ctx.authState.userId]?.voice?.replyMode,
						sessionOverride: session?.voiceReplyOverride,
						incomingWasVoice,
					})
				: ("text" as const);
			const ttsVoice = cmdCtx.config.users[ctx.authState.userId]?.voice?.ttsVoice;
			const draftHeader = incomingWasVoice ? "[Voice message received]" : "";
			const streamer = new ResponseStreamer(
				ctx,
				session?.showThinking ?? false,
				cmdCtx.config.autoSendImages,
				cmdCtx.ttsProvider,
				voiceReplyDecision,
				draftHeader,
				ttsVoice,
			);
			const listener = (event: RpcEvent): void => {
				void streamer.handleEvent(event).catch(error => {
					logger.warn("Failed streaming response event", { error: String(error) });
				});
			};

			client.onEvent(listener);
			try {
				await handleTelegramMessage(ctx, client, {
					sttProvider: cmdCtx.sttProvider,
					voiceConfig: cmdCtx.config.voice,
				});
			} finally {
				await awaitStreamerCompletion(streamer);
				client.offEvent?.(listener);
			}
		} catch (error) {
			logger.error("Failed handling message", { error: String(error), chatId });
			await ctx.reply(`Failed to process message: ${String(error)}`);
		}
	};
}

function registerShutdownHandlers(
	bot: TelegramBot,
	processManager: ProcessManager,
	tokenStore: TokenStore,
): () => void {
	let shuttingDown = false;

	const handleShutdown = async (signal: ShutdownSignal): Promise<void> => {
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		logger.debug("Stopping Telegram bot", { signal });
		bot.stop();
		await Promise.allSettled([
			tokenStore.save(),
			Promise.resolve(processManager.saveState()),
			Promise.resolve(processManager.killAll()),
		]);
	};

	const sigintHandler = (): void => {
		void handleShutdown("SIGINT");
	};
	const sigtermHandler = (): void => {
		void handleShutdown("SIGTERM");
	};

	process.on("SIGINT", sigintHandler);
	process.on("SIGTERM", sigtermHandler);

	return () => {
		process.off("SIGINT", sigintHandler);
		process.off("SIGTERM", sigtermHandler);
	};
}

export async function startBot(
	config: TelegramBridgeConfig,
	processManager: ProcessManager,
	operatorActionBridge?: OperatorActionHandler,
): Promise<TelegramBot> {
	const bot = new Bot<AuthContext>(config.botToken);
	const tokenStore = new TokenStore();
	await tokenStore.load();

	bot.catch(err => {
		logger.error("Telegram bot middleware error", {
			error: String(err.error),
			updateId: err.ctx.update.update_id,
		});
	});

	const me = await bot.api.getMe();
	const botUsername = me.username ?? "";
	const telegramPromptUrl = new URL("../bridge/telegram-prompt.md", import.meta.url);
	const telegramPrompt = (await Bun.file(telegramPromptUrl).text()).trim();
	let sttProvider: SttProvider | undefined;
	if (config.voice?.stt) {
		sttProvider = createSttProvider(config.voice.stt);
	}
	let ttsProvider: TtsProvider | undefined;
	if (config.voice?.tts) {
		ttsProvider = createTtsProvider(config.voice.tts);
	}
	const cmdCtx: CommandContext = {
		config,
		processManager,
		telegramPrompt,
		operatorActionBridge,
		sttProvider,
		ttsProvider,
	};

	bot.use(authMiddleware(config, tokenStore));
	registerCommands(bot, cmdCtx);
	bot.use(createCommandRouter(tokenStore, botUsername, cmdCtx));
	bot.use(createMessageHandler(cmdCtx));

	const unregisterHandlers = registerShutdownHandlers(bot, processManager, tokenStore);
	try {
		await bot.start();
		return bot;
	} finally {
		unregisterHandlers();
	}
}

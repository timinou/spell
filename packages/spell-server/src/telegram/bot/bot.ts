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

// Reply router middleware - added to route Telegram replies back to pending events
export function createReplyRouterMiddleware(
	replyRouter: any, // ReplyRouter type
	registry: any, // SocketSessionRegistry type
	telegramConfig: any, // TelegramChannelConfig type
): MiddlewareFn<AuthContext> {
	return async (ctx, next) => {
		const message = ctx.message;
		if (!message || message.message_id === undefined) {
			await next();
			return;
		}

		// Check if this is a reply to another message
		const orig = "reply_to_message" in message ? message.reply_to_message : null;
		if (!orig) {
			await next();
			return;
		}

		try {
			// Look up the pending reply mapping
			const pending = await replyRouter.lookup(orig.message_id);
			if (!pending) {
				// Not bound to a session, continue processing
				await next();
				return;
			}

			// Check if mapping is stale
			if (pending.stale) {
				await ctx.reply("That session has moved on; the question is no longer pending.");
				return;
			}

			// Verify auth
			const userId = ctx.from?.id;
			if (!userId || !telegramConfig.users[String(userId)]) {
				logger.warn("reply-router: unauthorized reply", { userId, chatId: ctx.chat?.id });
				return;
			}

			// Extract reply text
			const replyText = "text" in message ? message.text : "";
			if (!replyText) {
				await ctx.reply("Reply must contain text.");
				return;
			}

			// Resolve the event via registry
			registry.resolveEvent(pending.sessionId, pending.eventId, {
				kind: "hook_input",
				value: replyText,
			});

			await ctx.reply(`✓ delivered to your session`, { 
				reply_parameters: { message_id: ctx.message?.message_id } 
			});
		} catch (error) {
			logger.error("Reply router middleware error", { error: String(error) });
			// Don't disrupt normal message processing on error
			await next();
		}
	};
}

// Voice reply router handler - routes voice replies to pending events
export function createVoiceReplyHandler(
	replyRouter: any, // ReplyRouter type
	registry: any, // SocketSessionRegistry type
	telegramConfig: any, // TelegramChannelConfig type
	sttProvider?: SttProvider,
): MiddlewareFn<AuthContext> {
	return async (ctx, next) => {
		const message = ctx.message;
		if (!message || !("voice" in message) || !message.voice || message.message_id === undefined) {
			await next();
			return;
		}

		// Check if this is a reply to another message
		const orig = "reply_to_message" in message ? message.reply_to_message : null;
		if (!orig) {
			await next();
			return;
		}

		try {
			// Look up the pending reply mapping
			const pending = await replyRouter.lookup(orig.message_id);
			if (!pending) {
				// Not bound to a session, continue processing
				await next();
				return;
			}

			// Check if mapping is stale
			if (pending.stale) {
				await ctx.reply("That session has moved on; the question is no longer pending.");
				return;
			}

			// Verify auth
			const userId = ctx.from?.id;
			if (!userId || !telegramConfig.users[String(userId)]) {
				logger.warn("reply-router: unauthorized voice reply", { userId, chatId: ctx.chat?.id });
				return;
			}

			// Check if voice config is present
			if (!telegramConfig.voice?.stt) {
				await ctx.reply("Voice replies aren't enabled in your spell-server config.");
				return;
			}

			// Check if STT provider is available
			if (!sttProvider) {
				logger.error("STT provider not initialized for voice reply");
				await ctx.reply("Voice transcription is not available. Please contact the server administrator.");
				return;
			}

			// Download the voice file
			const voice = message.voice;
			const telegramFile = await ctx.api.getFile(voice.file_id);
			if (!telegramFile.file_path) {
				logger.error("Telegram voice file path missing", { fileId: voice.file_id });
				await ctx.reply("Failed to download voice file. Please try again.");
				return;
			}

			const fileUrl = `https://api.telegram.org/file/bot${telegramConfig.botToken}/${telegramFile.file_path}`;
			const response = await fetch(fileUrl);
			if (!response.ok) {
				logger.error("Failed to download voice from Telegram", { status: response.status, fileId: voice.file_id });
				await ctx.reply("Failed to download voice file. Please try again.");
				return;
			}

			const audioBuffer = Buffer.from(await response.arrayBuffer());

			// Transcribe the voice using STT provider
			let transcript = "";
			let confidence = 0;
			try {
				const sttLanguage = telegramConfig.voice.stt.language ?? "en";
				const result = await sttProvider.transcribe(audioBuffer, {
					mimeType: voice.mime_type ?? "audio/ogg",
					language: sttLanguage,
				});
				transcript = result.text?.trim() ?? "";
				confidence = result.confidence ?? 0;
			} catch (error) {
				logger.error("STT transcription failed", { error: String(error) });
				await ctx.reply("Voice transcription failed. Please try again or send text.");
				return;
			}

			// Check if transcription is confident enough
			if (confidence < 0.4 || !transcript) {
				await ctx.reply("Couldn't transcribe that voice note clearly. Please try again or send text.");
				return;
			}

			// Resolve the event via registry
			registry.resolveEvent(pending.sessionId, pending.eventId, {
				kind: "hook_input",
				value: transcript,
			});

			await ctx.reply(`✓ voice delivered as: ${transcript}`, {
				reply_parameters: { message_id: ctx.message?.message_id },
			});
		} catch (error) {
			logger.error("Voice reply handler error", { error: String(error) });
			await next();
		}
	};
}

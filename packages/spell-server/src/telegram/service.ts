import { logger } from "@oh-my-pi/pi-utils";
import { Bot } from "grammy";
import type { OperatorActionHandler } from "../http/routes/operator-actions";
import type { AuthContext } from "./bot/auth";
import { authMiddleware } from "./bot/auth";
import { createCommandRouter, createMessageHandler, type TelegramBot } from "./bot/bot";
import { TokenStore } from "./bot/tokens";
import { type CommandContext, registerCommands } from "./commands";
import { startLogViewer } from "./log-viewer/server";
import { ProcessManager } from "./process-manager";
import type { TelegramBridgeConfig } from "./types";
import { createSttProvider, createTtsProvider, type SttProvider, type TtsProvider } from "./voice";

export interface TelegramBotServiceOptions {
	config: TelegramBridgeConfig;
	operatorActionBridge?: OperatorActionHandler;
}

interface TelegramBotServiceDependencies {
	createBot?: (token: string) => TelegramBot;
}

/**
 * Top-level lifecycle wrapper for the Telegram bot subsystem.
 *
 * Owns: ProcessManager, grammy Bot, TokenStore, log-viewer server.
 * Call start() to launch the bot, stop() to tear it down.
 */
export class TelegramBotService {
	#config: TelegramBridgeConfig;
	#processManager: ProcessManager;
	#tokenStore: TokenStore;
	#bot: TelegramBot | null = null;
	#logViewerServer: { stop(): void } | null = null;
	#pollingTask: Promise<void> | null = null;
	#started = false;
	#createBot: (token: string) => TelegramBot;
	#operatorActionBridge?: OperatorActionHandler;

	constructor(options: TelegramBotServiceOptions, dependencies: TelegramBotServiceDependencies = {}) {
		this.#config = options.config;
		this.#processManager = new ProcessManager(this.#config);
		this.#tokenStore = new TokenStore();
		this.#createBot = dependencies.createBot ?? (token => new Bot<AuthContext>(token));
		this.#operatorActionBridge = options.operatorActionBridge;
	}

	get processManager(): ProcessManager {
		return this.#processManager;
	}

	async start(): Promise<void> {
		if (this.#started) {
			throw new Error("TelegramBotService is already started");
		}
		this.#started = true;

		try {
			await this.#processManager.loadState();
			await this.#tokenStore.load();

			const bot = this.#createBot(this.#config.botToken);

			bot.catch(err => {
				logger.error("Telegram bot middleware error", {
					error: String(err.error),
					updateId: err.ctx.update.update_id,
				});
			});

			const me = await bot.api.getMe();
			const botUsername = me.username ?? "";
			const telegramPromptUrl = new URL("./bridge/telegram-prompt.md", import.meta.url);
			const telegramPrompt = (await Bun.file(telegramPromptUrl).text()).trim();
			let sttProvider: SttProvider | undefined;
			if (this.#config.voice?.stt) {
				sttProvider = createSttProvider(this.#config.voice.stt);
			}
			let ttsProvider: TtsProvider | undefined;
			if (this.#config.voice?.tts) {
				ttsProvider = createTtsProvider(this.#config.voice.tts);
			}

			const cmdCtx: CommandContext = {
				config: this.#config,
				processManager: this.#processManager,
				telegramPrompt,
				operatorActionBridge: this.#operatorActionBridge,
				sttProvider,
				ttsProvider,
			};

			bot.use(authMiddleware(this.#config, this.#tokenStore));
			registerCommands(bot, cmdCtx);
			bot.use(createCommandRouter(this.#tokenStore, botUsername, cmdCtx));
			bot.use(createMessageHandler(cmdCtx));

			this.#bot = bot;

			if (this.#config.logViewerPort) {
				this.#logViewerServer = startLogViewer(this.#config, this.#processManager) ?? null;
			}

			const {
				promise: pollingStarted,
				resolve: markPollingStarted,
				reject: failPollingStarted,
			} = Promise.withResolvers<void>();
			let startupSettled = false;
			this.#pollingTask = bot
				.start({
					onStart: () => {
						logger.debug("Telegram bot started polling", { username: botUsername });
						startupSettled = true;
						markPollingStarted();
					},
				})
				.then(() => {
					if (startupSettled) {
						return;
					}
					startupSettled = true;
					failPollingStarted(new Error("Telegram bot polling stopped before startup completed"));
				})
				.catch(error => {
					if (!startupSettled) {
						startupSettled = true;
						failPollingStarted(error);
						return;
					}
					logger.error("Telegram bot polling stopped unexpectedly", { error: String(error) });
				});

			await pollingStarted;
		} catch (error) {
			await this.#cleanupFailedStart();
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (!this.#started) return;
		this.#started = false;

		logger.debug("Stopping Telegram bot service");

		const bot = this.#bot;
		this.#bot = null;
		if (bot) {
			await bot.stop();
		}
		const pollingTask = this.#pollingTask;
		this.#pollingTask = null;
		if (pollingTask) {
			await pollingTask;
		}

		if (this.#logViewerServer) {
			this.#logViewerServer.stop();
			this.#logViewerServer = null;
		}

		await Promise.allSettled([
			this.#tokenStore.save(),
			this.#processManager.saveState(),
			this.#processManager.killAll(),
		]);
	}

	async #cleanupFailedStart(): Promise<void> {
		this.#started = false;
		const bot = this.#bot;
		this.#bot = null;
		if (bot) {
			try {
				await bot.stop();
			} catch (error) {
				logger.warn("Ignoring Telegram bot stop failure during startup cleanup", { error: String(error) });
			}
		}
		const pollingTask = this.#pollingTask;
		this.#pollingTask = null;
		if (pollingTask) {
			await pollingTask;
		}
		if (this.#logViewerServer) {
			this.#logViewerServer.stop();
			this.#logViewerServer = null;
		}
	}
}

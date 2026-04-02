import { logger } from "@oh-my-pi/pi-utils";
import { Bot } from "grammy";
import type { AuthContext } from "./bot/auth";
import { authMiddleware } from "./bot/auth";
import { createCommandRouter, createMessageHandler, type TelegramBot } from "./bot/bot";
import { TokenStore } from "./bot/tokens";
import { type CommandContext, registerCommands } from "./commands";
import { startLogViewer } from "./log-viewer/server";
import { ProcessManager } from "./process-manager";
import type { TelegramBridgeConfig } from "./types";

export interface TelegramBotServiceOptions {
	config: TelegramBridgeConfig;
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
	#started = false;

	constructor(options: TelegramBotServiceOptions) {
		this.#config = options.config;
		this.#processManager = new ProcessManager(this.#config);
		this.#tokenStore = new TokenStore();
	}

	get processManager(): ProcessManager {
		return this.#processManager;
	}

	async start(): Promise<void> {
		if (this.#started) {
			throw new Error("TelegramBotService is already started");
		}
		this.#started = true;

		await this.#processManager.loadState();
		await this.#tokenStore.load();

		const bot = new Bot<AuthContext>(this.#config.botToken);

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

		const cmdCtx: CommandContext = {
			config: this.#config,
			processManager: this.#processManager,
			telegramPrompt,
		};

		bot.use(authMiddleware(this.#config, this.#tokenStore));
		registerCommands(bot, cmdCtx);
		bot.use(createCommandRouter(this.#tokenStore, botUsername, cmdCtx));
		bot.use(createMessageHandler(cmdCtx));

		this.#bot = bot;

		// Start log viewer if configured
		if (this.#config.logViewerPort) {
			this.#logViewerServer = startLogViewer(this.#config, this.#processManager) ?? null;
		}

		// Start polling (non-blocking)
		bot.start({
			onStart: () => {
				logger.debug("Telegram bot started polling", { username: botUsername });
			},
		});
	}

	async stop(): Promise<void> {
		if (!this.#started) return;
		this.#started = false;

		logger.debug("Stopping Telegram bot service");

		if (this.#bot) {
			this.#bot.stop();
			this.#bot = null;
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
}

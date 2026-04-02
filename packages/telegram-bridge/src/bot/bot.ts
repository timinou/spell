import { logger } from "@oh-my-pi/pi-utils";
import { Bot, type Context, type MiddlewareFn } from "grammy";
import { type CommandContext, registerCommands } from "../commands";
import { handleBtwCommand } from "../commands/btw";
import { handleModeCommand } from "../commands/mode";
import { handleProjectCommand } from "../commands/project";
import { handleClearCommand, handleStatusCommand, handleThinkCommand } from "../commands/session-commands";
import { handleHelpCommand, handleStartCommand } from "../commands/start-help";
import { handleLockCommand, handleUnlockCommand } from "../commands/unlock-lock";
import type { TelegramBridgeConfig } from "../config/types";
import type { ProcessManager } from "../rpc/process-manager";
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

function createCommandRouter(
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

function createMessageHandler(processManager: ProcessManager): MiddlewareFn<AuthContext> {
	return async (ctx, next) => {
		const text = ctx.message?.text;
		if (!text || text.startsWith("/")) {
			await next();
			return;
		}

		logger.debug("Received Telegram prompt", {
			chatId: String(ctx.chat?.id ?? ""),
			userId: ctx.authState.userId,
			messageLength: text.length,
		});

		void processManager;
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

export async function startBot(config: TelegramBridgeConfig, processManager: ProcessManager): Promise<TelegramBot> {
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
	const cmdCtx: CommandContext = {
		config,
		processManager,
	};

	registerCommands(bot, cmdCtx);
	bot.use(authMiddleware(config, tokenStore));
	bot.use(createCommandRouter(tokenStore, botUsername, cmdCtx));
	bot.use(createMessageHandler(processManager));

	const unregisterHandlers = registerShutdownHandlers(bot, processManager, tokenStore);
	try {
		await bot.start();
		return bot;
	} finally {
		unregisterHandlers();
	}
}

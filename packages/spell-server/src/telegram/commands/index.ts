import { logger } from "@oh-my-pi/pi-utils";
import type { OperatorActionHandler } from "../../http/routes/operator-actions";
import type { AuthContext } from "../bot/auth";
import type { TelegramBot } from "../bot/bot";
import type { ProcessManager } from "../process-manager";
import type { TelegramBridgeConfig, UserConfig } from "../types";
import type { SttProvider, TtsProvider } from "../voice";
import { registerApprovalCallbacks } from "./approval";
import { registerModeCallbacks } from "./mode";
import { registerProjectCallbacks } from "./project";
import { registerUnlockLockCallbacks } from "./unlock-lock";

export interface CommandContext {
	config: TelegramBridgeConfig;
	processManager: ProcessManager;
	telegramPrompt: string;
	operatorActionBridge?: OperatorActionHandler;
	sttProvider?: SttProvider;
	ttsProvider?: TtsProvider;
}

export type CommandHandler = (ctx: AuthContext, cmdCtx: CommandContext) => Promise<void>;

export const COMMANDS = [
	{ command: "start", description: "Start or authorize" },
	{ command: "help", description: "Show available commands" },
	{ command: "unlock", description: "Switch to full tool access (owner only)" },
	{ command: "lock", description: "Switch back to read-only mode" },
	{ command: "project", description: "Switch project" },
	{ command: "mode", description: "Switch tool mode" },
	{ command: "think", description: "Toggle thinking visibility" },
	{ command: "clear", description: "Start new session" },
	{ command: "status", description: "Show session status" },
	{ command: "btw", description: "One-off question without session context" },
	{ command: "voice", description: "Toggle voice reply mode" },
] as const;

/** Canonical tool lists per mode. The bridge passes these via --tools to the RPC process. */
const MODE_TOOLS: Record<string, string[]> = {
	"telegram-readonly": [
		"read",
		"grep",
		"find",
		"lsp",
		"ast_grep",
		"web_search",
		"fetch",
		"org",
		"calc",
		"code_search",
		"send_file",
	],
	"telegram-full": [
		"read",
		"grep",
		"find",
		"lsp",
		"ast_grep",
		"web_search",
		"fetch",
		"org",
		"calc",
		"code_search",
		"edit",
		"write",
		"bash",
		"ast_edit",
		"task",
		"todo_write",
		"emacs_code",
		"notebook",
		"generate_image",
		"send_file",
	],
};

export function resolveModeTools(mode: string): string[] {
	const tools = MODE_TOOLS[mode] ?? MODE_TOOLS["telegram-readonly"];
	return tools ? [...tools] : [];
}

export function resolveDefaultProject(config: TelegramBridgeConfig): string {
	if (config.defaultProject && config.projects[config.defaultProject]) {
		return config.defaultProject;
	}

	const [firstProject] = Object.keys(config.projects);
	if (!firstProject) {
		throw new Error("No projects configured for Telegram bridge");
	}
	return firstProject;
}

export function resolveAllowedProjects(config: TelegramBridgeConfig, userConfig: UserConfig): string[] {
	const configured = Object.keys(config.projects);
	if (!userConfig.projects || userConfig.projects.length === 0) {
		return configured;
	}

	const allowed = userConfig.projects.filter(projectName => Boolean(config.projects[projectName]));
	return allowed.length > 0 ? allowed : configured;
}

export function resolveChatId(ctx: AuthContext): string | null {
	if (ctx.chat && typeof ctx.chat.id === "number") {
		return String(ctx.chat.id);
	}

	const callbackChat = ctx.callbackQuery?.message?.chat;
	if (callbackChat && typeof callbackChat.id === "number") {
		return String(callbackChat.id);
	}

	return null;
}

export function parseCommandArgument(ctx: AuthContext): string {
	const text = ctx.message?.text?.trim();
	if (!text?.startsWith("/")) {
		return "";
	}

	const firstSpace = text.indexOf(" ");
	if (firstSpace === -1) {
		return "";
	}
	return text.slice(firstSpace + 1).trim();
}

export async function respawnSession(
	ctx: AuthContext,
	cmdCtx: CommandContext,
	overrides: { mode?: string; project?: string },
): Promise<void> {
	const chatId = resolveChatId(ctx);
	if (!chatId) {
		throw new Error("Chat ID unavailable");
	}

	const existingSession = cmdCtx.processManager.getSession(chatId);
	const project = overrides.project ?? existingSession?.project ?? resolveDefaultProject(cmdCtx.config);
	const mode = overrides.mode ?? existingSession?.mode ?? ctx.authState.userConfig.defaultMode;

	if (existingSession) {
		await cmdCtx.processManager.kill(chatId);
	}

	await cmdCtx.processManager.getOrCreate(chatId, ctx.authState.userId, {
		project,
		mode,
		tools: resolveModeTools(mode),
		appendSystemPrompt: cmdCtx.telegramPrompt,
		sessionPath: existingSession?.sessionPath,
	});
}

export function registerCommands(bot: TelegramBot, cmdCtx: CommandContext): void {
	registerUnlockLockCallbacks(bot, cmdCtx);
	registerProjectCallbacks(bot, cmdCtx);
	registerModeCallbacks(bot, cmdCtx);
	registerApprovalCallbacks(bot, cmdCtx);

	void bot.api.setMyCommands(COMMANDS).catch(error => {
		logger.warn("Failed to register Telegram bot commands", { error: String(error) });
	});
}

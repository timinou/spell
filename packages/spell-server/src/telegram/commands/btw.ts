import { logger } from "@spell/pi-utils";
import { RpcClient } from "../../rpc/rpc-client";
import type { RpcEvent, RpcSpawnOptions } from "../../rpc/types";
import type { AuthContext } from "../bot/auth";
import { awaitStreamerCompletion, ResponseStreamer } from "../bridge/rpc-to-telegram";
import {
	type CommandContext,
	parseCommandArgument,
	resolveChatId,
	resolveDefaultProject,
	resolveModeTools,
} from "./index";

interface BtwDependencies {
	createClient?: (options: RpcSpawnOptions) => RpcClient;
	createStreamer?: (
		ctx: AuthContext,
		showThinking: boolean,
		autoSendImages: boolean,
	) => {
		handleEvent: (event: RpcEvent) => Promise<void>;
		done: Promise<void>;
		cancel: () => void;
	};
	loadPrompt?: () => Promise<string>;
}

const TELEGRAM_PROMPT_URL = new URL("../bridge/telegram-prompt.md", import.meta.url);

async function loadTelegramPrompt(): Promise<string> {
	return (await Bun.file(TELEGRAM_PROMPT_URL).text()).trim();
}

export async function handleBtwCommand(
	ctx: AuthContext,
	cmdCtx: CommandContext,
	dependencies: BtwDependencies = {},
): Promise<void> {
	const question = parseCommandArgument(ctx);
	if (!question) {
		await ctx.reply("Usage: /btw <question>");
		return;
	}

	const chatId = resolveChatId(ctx);
	const session = chatId ? cmdCtx.processManager.getSession(chatId) : undefined;
	const project = session?.project ?? resolveDefaultProject(cmdCtx.config);
	const cwd = cmdCtx.config.projects[project];
	if (!cwd) {
		await ctx.reply(`Unknown project '${project}'`);
		return;
	}

	const mode = session?.mode ?? ctx.authState.userConfig.defaultMode;
	const tools = resolveModeTools(mode);
	const createClient = dependencies.createClient ?? (options => new RpcClient(options));
	const createStreamer =
		dependencies.createStreamer ??
		((authCtx, showThinking, autoSendImages) => new ResponseStreamer(authCtx, showThinking, autoSendImages));
	const loadPrompt = dependencies.loadPrompt ?? loadTelegramPrompt;
	const promptText = await loadPrompt();

	const client = createClient({
		cwd,
		tools,
		noSession: true,
		model: cmdCtx.config.defaultModel,
		appendSystemPrompt: promptText,
	});
	const streamer = createStreamer(ctx, false, cmdCtx.config.autoSendImages);

	const listener = (event: RpcEvent): void => {
		void streamer.handleEvent(event).catch(error => {
			logger.warn("Failed streaming /btw response event", { error: String(error) });
		});
	};
	client.onEvent(listener);

	try {
		await client.start();
		await client.prompt(question);
	} catch (error) {
		logger.error("Failed executing /btw command", {
			error: String(error),
			userId: ctx.authState.userId,
		});
		await ctx.reply(`Failed to run /btw: ${String(error)}`);
	} finally {
		await awaitStreamerCompletion(streamer);
		client.offEvent?.(listener);
		await client.kill();
	}
}

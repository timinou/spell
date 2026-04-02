import { logger } from "@oh-my-pi/pi-utils";
import type { AuthContext } from "../bot/auth";
import { ResponseStreamer } from "../bridge/rpc-to-telegram";
import { RpcClient } from "../rpc/rpc-client";
import type { RpcEvent, RpcSpawnOptions } from "../rpc/types";
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
	) => {
		handleEvent: (event: RpcEvent) => Promise<void>;
		done: Promise<void>;
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
		dependencies.createStreamer ?? ((authCtx, showThinking) => new ResponseStreamer(authCtx, showThinking));
	const loadPrompt = dependencies.loadPrompt ?? loadTelegramPrompt;
	const promptText = await loadPrompt();

	const client = createClient({
		cwd,
		tools,
		noSession: true,
		appendSystemPrompt: promptText,
	});
	const streamer = createStreamer(ctx, false);

	client.onEvent(event => {
		void streamer.handleEvent(event).catch(error => {
			logger.warn("Failed streaming /btw response event", { error: String(error) });
		});
	});

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
		await streamer.done;
		await client.kill();
	}
}

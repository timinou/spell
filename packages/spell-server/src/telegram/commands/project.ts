import { InlineKeyboard } from "grammy";
import type { AuthContext } from "../bot/auth";
import type { TelegramBot } from "../bot/bot";
import {
	type CommandContext,
	parseCommandArgument,
	resolveAllowedProjects,
	resolveChatId,
	respawnSession,
} from "./index";

const PROJECT_CALLBACK_PREFIX = "project:";

function projectKeyboard(projects: string[]): InlineKeyboard {
	const keyboard = new InlineKeyboard();
	for (const project of projects) {
		keyboard.text(project, `${PROJECT_CALLBACK_PREFIX}${project}`).row();
	}
	return keyboard;
}

function parseProjectFromCallback(match: string | RegExpMatchArray): string {
	if (Array.isArray(match)) {
		return match[1] ?? "";
	}
	if (match.startsWith(PROJECT_CALLBACK_PREFIX)) {
		return match.slice(PROJECT_CALLBACK_PREFIX.length);
	}
	return "";
}

async function switchProject(ctx: AuthContext, cmdCtx: CommandContext, projectName: string): Promise<void> {
	const chatId = resolveChatId(ctx);
	if (!chatId) {
		throw new Error("Chat ID unavailable");
	}

	const session = cmdCtx.processManager.getSession(chatId);
	await respawnSession(ctx, cmdCtx, {
		project: projectName,
		mode: session?.mode,
	});
}

function availableProjectsMessage(projects: string[]): string {
	return `Available projects: ${projects.join(", ")}`;
}

async function replyUnknownProject(ctx: AuthContext, projects: string[]): Promise<void> {
	await ctx.reply(`Unknown project. ${availableProjectsMessage(projects)}`);
}

export async function handleProjectCommand(ctx: AuthContext, cmdCtx: CommandContext): Promise<void> {
	const projects = resolveAllowedProjects(cmdCtx.config, ctx.authState.userConfig);
	if (projects.length === 0) {
		await ctx.reply("No projects are available for your account.");
		return;
	}

	const selected = parseCommandArgument(ctx);
	if (!selected) {
		await ctx.reply("Select a project:", {
			reply_markup: projectKeyboard(projects),
		});
		return;
	}

	if (!projects.includes(selected)) {
		await replyUnknownProject(ctx, projects);
		return;
	}

	await switchProject(ctx, cmdCtx, selected);
	await ctx.reply(`Switched to project: ${selected}`);
}

export function registerProjectCallbacks(bot: TelegramBot, cmdCtx: CommandContext): void {
	bot.callbackQuery(/^project:(.+)$/i, async ctx => {
		await ctx.answerCallbackQuery();

		const allowedProjects = resolveAllowedProjects(cmdCtx.config, ctx.authState.userConfig);
		const projectName = parseProjectFromCallback(ctx.match);
		if (!projectName || !allowedProjects.includes(projectName)) {
			await ctx.reply(`Project unavailable. ${availableProjectsMessage(allowedProjects)}`);
			return;
		}

		try {
			await switchProject(ctx, cmdCtx, projectName);
			await ctx.editMessageText(`Switched to project: ${projectName}`);
		} catch {
			await ctx.reply("Unable to switch project right now.");
		}
	});
}

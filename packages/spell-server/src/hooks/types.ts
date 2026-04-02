import type { GoalResult } from "../executor/types";
import type { HookTarget } from "../manifest/types";

export type TelegramParseMode = "Markdown" | "MarkdownV2" | "HTML";

export interface TelegramInlineKeyboardButton {
	text: string;
	url?: string;
	callbackData?: string;
}

export interface TelegramInlineKeyboardMarkup {
	inlineKeyboard: TelegramInlineKeyboardButton[][];
}

export interface TelegramLinkPreviewOptions {
	isDisabled?: boolean;
	url?: string;
	preferSmallMedia?: boolean;
	preferLargeMedia?: boolean;
	showAboveText?: boolean;
}

export interface TelegramMessagePayload {
	text: string;
	parseMode?: TelegramParseMode;
	replyMarkup?: TelegramInlineKeyboardMarkup;
	linkPreviewOptions?: TelegramLinkPreviewOptions;
}

export type TelegramMessage = string | TelegramMessagePayload;

export interface HookExecutor {
	execute(target: HookTarget, result: GoalResult, context: HookContext): Promise<void>;
}

export interface HookContext {
	goalName: string;
	timestamp: Date;
	telegramMessage?: TelegramMessagePayload;
}

export type HookCategory = "onSuccess" | "onFailure" | "onComplete";

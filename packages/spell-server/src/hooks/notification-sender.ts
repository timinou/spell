import { logger } from "@spell/pi-utils";
import { InputFile } from "grammy";
import type { ChannelsConfig } from "../config/types";
import { enforceCaptionBudget } from "../telegram/caption-budget";
import type {
	TelegramInlineKeyboardButton,
	TelegramInlineKeyboardMarkup,
	TelegramLinkPreviewOptions,
	TelegramParseMode,
	TelegramMessage,
	TelegramMessagePayload,
} from "./types";

export interface NotificationSender {
	sendMessage(chatId: number, message: TelegramMessage): Promise<{ messageId: number }>;
	sendDocument(chatId: number, doc: {
		buffer: Buffer;
		fileName: string;
		mime: string;
		caption?: string;
		parseMode?: TelegramParseMode;
		replyMarkup?: TelegramInlineKeyboardMarkup;
	}): Promise<{ messageId: number }>;
}

export interface TelegramNotificationSenderOptions {
	apiBaseUrl?: string;
	fetchImpl?: typeof fetch;
}

interface TelegramSendMessageRequestBody {
	chat_id: number;
	text: string;
	parse_mode?: TelegramMessagePayload["parseMode"];
	reply_markup?: {
		inline_keyboard: Array<Array<{ text: string; url?: string; callback_data?: string }>>;
	};
	link_preview_options?: {
		is_disabled?: boolean;
		url?: string;
		prefer_small_media?: boolean;
		prefer_large_media?: boolean;
		show_above_text?: boolean;
	};
}

function normalizeMessage(message: TelegramMessage): TelegramMessagePayload {
	return typeof message === "string" ? { text: message } : message;
}

function toInlineKeyboardButton(button: TelegramInlineKeyboardButton): {
	text: string;
	url?: string;
	callback_data?: string;
} {
	return {
		text: button.text,
		...(button.url ? { url: button.url } : {}),
		...(button.callbackData ? { callback_data: button.callbackData } : {}),
	};
}

function toReplyMarkup(replyMarkup: TelegramInlineKeyboardMarkup): TelegramSendMessageRequestBody["reply_markup"] {
	return {
		inline_keyboard: replyMarkup.inlineKeyboard.map(row => row.map(button => toInlineKeyboardButton(button))),
	};
}

function toLinkPreviewOptions(
	linkPreviewOptions: TelegramLinkPreviewOptions,
): TelegramSendMessageRequestBody["link_preview_options"] {
	return {
		...(linkPreviewOptions.isDisabled !== undefined ? { is_disabled: linkPreviewOptions.isDisabled } : {}),
		...(linkPreviewOptions.url ? { url: linkPreviewOptions.url } : {}),
		...(linkPreviewOptions.preferSmallMedia !== undefined
			? { prefer_small_media: linkPreviewOptions.preferSmallMedia }
			: {}),
		...(linkPreviewOptions.preferLargeMedia !== undefined
			? { prefer_large_media: linkPreviewOptions.preferLargeMedia }
			: {}),
		...(linkPreviewOptions.showAboveText !== undefined ? { show_above_text: linkPreviewOptions.showAboveText } : {}),
	};
}

function toRequestBody(chatId: number, message: TelegramMessage): TelegramSendMessageRequestBody {
	const payload = normalizeMessage(message);
	return {
		chat_id: chatId,
		text: payload.text,
		...(payload.parseMode ? { parse_mode: payload.parseMode } : {}),
		...(payload.replyMarkup ? { reply_markup: toReplyMarkup(payload.replyMarkup) } : {}),
		...(payload.linkPreviewOptions ? { link_preview_options: toLinkPreviewOptions(payload.linkPreviewOptions) } : {}),
	};
}

export class NoopNotificationSender implements NotificationSender {
	async sendMessage(_chatId: number, _message: TelegramMessage): Promise<{ messageId: number }> {
		// No-op when Telegram is not configured.
		return { messageId: 0 };
	}

	async sendDocument(
		_chatId: number,
		_doc: {
			buffer: Buffer;
			fileName: string;
			mime: string;
			caption?: string;
			parseMode?: TelegramParseMode;
			replyMarkup?: TelegramInlineKeyboardMarkup;
		},
	): Promise<{ messageId: number }> {
		// No-op when Telegram is not configured.
		return { messageId: 0 };
	}
}

export class TelegramNotificationSender implements NotificationSender {
	#botToken: string;
	#owners: Set<number>;
	#apiBaseUrl: string;
	#fetchImpl: typeof fetch;

	constructor(botToken: string, owners: Set<number>, options: TelegramNotificationSenderOptions = {}) {
		this.#botToken = botToken;
		this.#owners = owners;
		this.#apiBaseUrl = options.apiBaseUrl ?? "https://api.telegram.org";
		this.#fetchImpl = options.fetchImpl ?? fetch;
	}

	async sendMessage(chatId: number, message: TelegramMessage): Promise<{ messageId: number }> {
		if (!this.#owners.has(chatId)) {
			logger.warn("Skipping Telegram notification for unauthorized chat", { chatId });
			return { messageId: 0 };
		}

		const response = await this.#fetchImpl(`${this.#apiBaseUrl}/bot${this.#botToken}/sendMessage`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(toRequestBody(chatId, message)),
		});
		if (response.ok) {
			const json = (await response.json()) as { ok: boolean; result: { message_id: number } };
			return { messageId: json.result.message_id };
		}

		const responseText = await response.text();
		throw new Error(`Telegram send failed with ${response.status}: ${responseText}`);
	}

	async sendDocument(chatId: number, doc: {
		buffer: Buffer;
		fileName: string;
		mime: string;
		caption?: string;
		parseMode?: TelegramParseMode;
		replyMarkup?: TelegramInlineKeyboardMarkup;
	}): Promise<{ messageId: number }> {
		if (!this.#owners.has(chatId)) {
			logger.warn("Skipping Telegram document notification for unauthorized chat", { chatId });
			return { messageId: 0 };
		}

		const caption = doc.caption ? enforceCaptionBudget(doc.caption, 'document') : undefined;

		// Use FormData to send the file as multipart/form-data
		const formData = new FormData();
		formData.append('chat_id', String(chatId));
		formData.append('document', new Blob([doc.buffer], { type: doc.mime }), doc.fileName);
		if (caption) {
			formData.append('caption', caption);
		}
		if (doc.parseMode) {
			formData.append('parse_mode', doc.parseMode);
		}
		if (doc.replyMarkup) {
			formData.append('reply_markup', JSON.stringify({
				inline_keyboard: doc.replyMarkup.inlineKeyboard.map(row =>
					row.map(button => toInlineKeyboardButton(button))
				),
			}));
		}

		const response = await this.#fetchImpl(`${this.#apiBaseUrl}/bot${this.#botToken}/sendDocument`, {
			method: "POST",
			body: formData,
		});
		if (response.ok) {
			const json = (await response.json()) as { ok: boolean; result: { message_id: number } };
			return { messageId: json.result.message_id };
		}

		const responseText = await response.text();
		throw new Error(`Telegram sendDocument failed with ${response.status}: ${responseText}`);
	}
}

export function createNotificationSender(
	channels: ChannelsConfig,
	options: TelegramNotificationSenderOptions = {},
): NotificationSender {
	const telegramConfig = channels.telegram;
	if (!telegramConfig) {
		return new NoopNotificationSender();
	}

	return new TelegramNotificationSender(telegramConfig.botToken, new Set(telegramConfig.owners), options);
}

import { logger } from "@oh-my-pi/pi-utils";
import type { ChannelsConfig } from "../config/types";

export interface NotificationSender {
	sendMessage(chatId: number, text: string): Promise<void>;
}

export interface TelegramNotificationSenderOptions {
	apiBaseUrl?: string;
	fetchImpl?: typeof fetch;
}

export class NoopNotificationSender implements NotificationSender {
	async sendMessage(_chatId: number, _text: string): Promise<void> {
		// No-op when Telegram is not configured.
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

	async sendMessage(chatId: number, text: string): Promise<void> {
		if (!this.#owners.has(chatId)) {
			logger.warn("Skipping Telegram notification for unauthorized chat", { chatId });
			return;
		}

		const response = await this.#fetchImpl(`${this.#apiBaseUrl}/bot${this.#botToken}/sendMessage`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chat_id: chatId, text }),
		});
		if (response.ok) {
			return;
		}

		const responseText = await response.text();
		throw new Error(`Telegram send failed with ${response.status}: ${responseText}`);
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

export interface NotificationSender {
	sendMessage(chatId: number, text: string): Promise<void>;
}

export class NoopNotificationSender implements NotificationSender {
	async sendMessage(_chatId: number, _text: string): Promise<void> {
		// No-op when Telegram is not configured.
	}
}

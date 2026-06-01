import { logger } from "@spell/pi-utils";
import type { GoalResult } from "../executor/types";
import type { TelegramHook } from "../manifest/types";
import { NoopNotificationSender, type NotificationSender } from "./notification-sender";
import type { HookContext, HookExecutor, TelegramMessagePayload } from "./types";

export class TelegramHookExecutor implements HookExecutor {
	#sender: NotificationSender;

	constructor(sender: NotificationSender) {
		this.#sender = sender;
	}

	async execute(target: TelegramHook, result: GoalResult, context: HookContext): Promise<void> {
		if (this.#sender instanceof NoopNotificationSender) {
			return;
		}

		try {
			await this.#sender.sendMessage(target.chatId, context.telegramMessage ?? this.#formatMessage(result, context));
		} catch (error) {
			logger.warn("Telegram hook failed", {
				chatId: target.chatId,
				error: String(error),
			});
		}
	}

	#formatMessage(result: GoalResult, context: HookContext): TelegramMessagePayload {
		const lines = [`Goal: ${context.goalName}`, `Status: ${result.status}`, `Duration: ${result.duration}ms`];
		if (result.error) {
			lines.push(`Error: ${result.error}`);
		}
		if (result.summary) {
			lines.push(`Summary: ${result.summary}`);
		}
		return { text: lines.join("\n") };
	}
}

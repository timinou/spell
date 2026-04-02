import { describe, expect, it } from "bun:test";
import type { GoalResult } from "../../src/executor";
import type { HookContext, TelegramMessage } from "../../src/hooks";
import { TelegramHookExecutor } from "../../src/hooks";
import type { TelegramHook } from "../../src/manifest";

const BASE_RESULT: GoalResult = {
	goalName: "nightly",
	status: "success",
	duration: 321,
	runs: [],
	summary: "All checks passed",
};

const BASE_CONTEXT: HookContext = {
	goalName: "nightly",
	timestamp: new Date("2026-04-02T12:34:56.000Z"),
};

class RecordingSender {
	calls: Array<{ chatId: number; message: TelegramMessage }> = [];

	async sendMessage(chatId: number, message: TelegramMessage): Promise<void> {
		this.calls.push({ chatId, message });
	}
}

class FailingSender {
	async sendMessage(): Promise<void> {
		throw new Error("telegram offline");
	}
}

describe("TelegramHookExecutor", () => {
	it("formats legacy goal notifications without changing the summary text", async () => {
		const sender = new RecordingSender();
		const executor = new TelegramHookExecutor(sender);
		const target: TelegramHook = { type: "telegram", chatId: 42 };

		await executor.execute(target, BASE_RESULT, BASE_CONTEXT);

		expect(sender.calls).toEqual([
			{
				chatId: 42,
				message: {
					text: ["Goal: nightly", "Status: success", "Duration: 321ms", "Summary: All checks passed"].join("\n"),
				},
			},
		]);
	});

	it("passes through prebuilt telegram payloads", async () => {
		const sender = new RecordingSender();
		const executor = new TelegramHookExecutor(sender);
		const target: TelegramHook = { type: "telegram", chatId: 42 };
		const richContext: HookContext = {
			...BASE_CONTEXT,
			telegramMessage: {
				text: "<b>Nightly digest</b>",
				parseMode: "HTML",
				replyMarkup: {
					inlineKeyboard: [[{ text: "Open run", url: "https://example.test/runs/1" }]],
				},
				linkPreviewOptions: {
					isDisabled: true,
				},
			},
		};

		await executor.execute(target, BASE_RESULT, richContext);

		expect(sender.calls).toEqual([
			{
				chatId: 42,
				message: richContext.telegramMessage!,
			},
		]);
	});

	it("swallows sender failures", async () => {
		const executor = new TelegramHookExecutor(new FailingSender() as never);
		const target: TelegramHook = { type: "telegram", chatId: 42 };

		await expect(executor.execute(target, BASE_RESULT, BASE_CONTEXT)).resolves.toBeUndefined();
	});
});

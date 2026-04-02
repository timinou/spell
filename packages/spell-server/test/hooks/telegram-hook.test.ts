import { describe, expect, it } from "bun:test";
import type { GoalResult } from "../../src/executor";
import type { HookContext } from "../../src/hooks";
import {
	createNotificationSender,
	NoopNotificationSender,
	type NotificationSender,
	TelegramHookExecutor,
	TelegramNotificationSender,
} from "../../src/hooks";
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

class RecordingSender implements NotificationSender {
	calls: Array<{ chatId: number; text: string }> = [];

	async sendMessage(chatId: number, text: string): Promise<void> {
		this.calls.push({ chatId, text });
	}
}

class FailingSender implements NotificationSender {
	async sendMessage(): Promise<void> {
		throw new Error("telegram offline");
	}
}

async function withServer(
	handler: (request: Request) => Response | Promise<Response>,
	run: (url: string) => Promise<void>,
): Promise<void> {
	const server = Bun.serve({
		port: 0,
		fetch: handler,
	});

	try {
		await run(server.url.toString().replace(/\/$/, ""));
	} finally {
		await server.stop(true);
	}
}

describe("notification sender wiring", () => {
	it("returns a noop sender when telegram channels are not configured", () => {
		const sender = createNotificationSender({});
		expect(sender).toBeInstanceOf(NoopNotificationSender);
	});

	it("creates a telegram sender that posts configured messages", async () => {
		const requests: Array<{ path: string; body: { chat_id: number; text: string } }> = [];

		await withServer(
			async request => {
				requests.push({
					path: new URL(request.url).pathname,
					body: (await request.json()) as { chat_id: number; text: string },
				});
				return new Response("ok");
			},
			async url => {
				const sender = createNotificationSender(
					{ telegram: { botToken: "123456:ABC", owners: [42] } },
					{ apiBaseUrl: url },
				);
				expect(sender).toBeInstanceOf(TelegramNotificationSender);
				await sender.sendMessage(42, "Goal failed");
			},
		);

		expect(requests).toEqual([
			{
				path: "/bot123456:ABC/sendMessage",
				body: { chat_id: 42, text: "Goal failed" },
			},
		]);
	});

	it("skips unauthorized telegram recipients", async () => {
		let requestCount = 0;

		await withServer(
			() => {
				requestCount += 1;
				return new Response("ok");
			},
			async url => {
				const sender = new TelegramNotificationSender("123456:ABC", new Set([42]), { apiBaseUrl: url });
				await sender.sendMessage(99, "ignore me");
			},
		);

		expect(requestCount).toBe(0);
	});
});

describe("TelegramHookExecutor", () => {
	it("formats and sends hook messages", async () => {
		const sender = new RecordingSender();
		const executor = new TelegramHookExecutor(sender);
		const target: TelegramHook = { type: "telegram", chatId: 42 };

		await executor.execute(target, BASE_RESULT, BASE_CONTEXT);

		expect(sender.calls).toEqual([
			{
				chatId: 42,
				text: ["Goal: nightly", "Status: success", "Duration: 321ms", "Summary: All checks passed"].join("\n"),
			},
		]);
	});

	it("swallows sender failures", async () => {
		const executor = new TelegramHookExecutor(new FailingSender());
		const target: TelegramHook = { type: "telegram", chatId: 42 };

		await expect(executor.execute(target, BASE_RESULT, BASE_CONTEXT)).resolves.toBeUndefined();
	});
});

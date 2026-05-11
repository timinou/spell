import { describe, expect, it } from "bun:test";
import {
	createNotificationSender,
	NoopNotificationSender,
	type NotificationSender,
	TelegramNotificationSender,
} from "../../src/hooks";

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

	it("keeps legacy text sends working for existing callers", async () => {
		const requests: Array<{ path: string; body: { chat_id: number; text: string } }> = [];

		await withServer(
			async request => {
				requests.push({
					path: new URL(request.url).pathname,
					body: (await request.json()) as { chat_id: number; text: string },
				});
				return new Response(
					JSON.stringify({
						ok: true,
						result: { message_id: 123 },
					})
				);
			},
			async url => {
				const sender = createNotificationSender(
					{
						telegram: {
							botToken: "123456:ABC",
							owners: [42],
							uploadDir: "/tmp/test-uploads",
							idleTimeout: 300,
							maxSessions: 3,
							defaultModel: "claude-sonnet-4-5",
							autoSendImages: true,
							projects: {},
							users: {},
						},
					},
					{ apiBaseUrl: url },
				) as NotificationSender;
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

	it("serializes structured telegram payloads without dropping optional fields", async () => {
		const requests: Array<{ path: string; body: unknown }> = [];

		await withServer(
			async request => {
				requests.push({
					path: new URL(request.url).pathname,
					body: await request.json(),
				});
				return new Response(
					JSON.stringify({
						ok: true,
						result: { message_id: 456 },
					})
				);
			},
			async url => {
				const sender = new TelegramNotificationSender("123456:ABC", new Set([42]), { apiBaseUrl: url });
				await sender.sendMessage(42, {
					text: "<b>Nightly digest</b>",
					parseMode: "HTML",
					replyMarkup: {
						inlineKeyboard: [
							[
								{ text: "Open run", url: "https://example.test/runs/1" },
								{ text: "Approve", callbackData: "approve:nightly:1" },
							],
						],
					},
					linkPreviewOptions: {
						isDisabled: false,
						preferLargeMedia: true,
						showAboveText: true,
						url: "https://example.test/digest",
					},
				});
			},
		);

		expect(requests).toEqual([
			{
				path: "/bot123456:ABC/sendMessage",
				body: {
					chat_id: 42,
					text: "<b>Nightly digest</b>",
					parse_mode: "HTML",
					reply_markup: {
						inline_keyboard: [
							[
								{ text: "Open run", url: "https://example.test/runs/1" },
								{ text: "Approve", callback_data: "approve:nightly:1" },
							],
						],
					},
					link_preview_options: {
						is_disabled: false,
						prefer_large_media: true,
						show_above_text: true,
						url: "https://example.test/digest",
					},
				},
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
				await sender.sendMessage(99, {
					text: "ignore me",
					parseMode: "MarkdownV2",
				});
			},
		);

		expect(requestCount).toBe(0);
	});

	it("returns messageId from sendMessage", async () => {
		let messageId: number = 0;

		await withServer(
			async request => {
				return new Response(
					JSON.stringify({
						ok: true,
						result: { message_id: 12345 },
					})
				);
			},
			async url => {
				const sender = new TelegramNotificationSender("123456:ABC", new Set([42]), {
					apiBaseUrl: url,
				});
				const result = await sender.sendMessage(42, "Test");
				messageId = result.messageId;
			},
		);

		expect(messageId).toBe(12345);
	});

	it("sendDocument enforces caption budget", async () => {
		const captions: string[] = [];

		await withServer(
			async request => {
				if (request.method === "POST") {
					const formData = await request.formData();
					const caption = formData.get("caption");
					if (caption) captions.push(String(caption));
				}
				return new Response(
					JSON.stringify({
						ok: true,
						result: { message_id: 999 },
					})
				);
			},
			async url => {
				const sender = new TelegramNotificationSender("123456:ABC", new Set([42]), {
					apiBaseUrl: url,
				});
				const longCaption = "x".repeat(2000);
				await sender.sendDocument(42, {
					buffer: Buffer.from("PDF"),
					fileName: "test.pdf",
					mime: "application/pdf",
					caption: longCaption,
				});
			},
		);

		expect(captions).toHaveLength(1);
		expect(captions[0]).toHaveLength(1024);
	});

	it("sendDocument skips unauthorized recipients", async () => {
		let requestCount = 0;

		await withServer(
			() => {
				requestCount += 1;
				return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
			},
			async url => {
				const sender = new TelegramNotificationSender("123456:ABC", new Set([42]), {
					apiBaseUrl: url,
				});
				const result = await sender.sendDocument(99, {
					buffer: Buffer.from("data"),
					fileName: "test.pdf",
					mime: "application/pdf",
				});
				expect(result.messageId).toBe(0);
			},
		);

		expect(requestCount).toBe(0);
	});

	it("NoopNotificationSender.sendDocument returns messageId: 0", async () => {
		const sender = new NoopNotificationSender();
		const result = await sender.sendDocument(42, {
			buffer: Buffer.from("test"),
			fileName: "test.pdf",
			mime: "application/pdf",
		});
		expect(result.messageId).toBe(0);
	});
});

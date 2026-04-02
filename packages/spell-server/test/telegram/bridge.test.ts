import { describe, expect, it } from "bun:test";
import { hookFetch } from "@oh-my-pi/pi-utils";
import type { RpcClient } from "../../src/rpc/rpc-client";
import type { AssistantEvent, ImageContentRef, RpcEvent } from "../../src/rpc/types";
import type { AuthContext } from "../../src/telegram/bot/auth";
import { markdownToTelegramHtml } from "../../src/telegram/bridge/markdown-html";
import { splitMessage } from "../../src/telegram/bridge/message-splitter";
import { awaitStreamerCompletion, ResponseStreamer } from "../../src/telegram/bridge/rpc-to-telegram";
import { handleTelegramMessage } from "../../src/telegram/bridge/telegram-to-rpc";

interface MockReply {
	text: string;
	options?: Record<string, unknown>;
}

interface MockDraft {
	chat_id: number;
	text: string;
}

interface MockPhoto {
	file_id: string;
	file_size?: number;
}

interface MockDocument {
	file_id: string;
	file_name?: string;
	mime_type?: string;
}

interface MockAuthContextOptions {
	chatId: number;
	text?: string;
	photo?: MockPhoto[];
	document?: MockDocument;
	fileMap?: Record<string, string>;
}

interface MockAuthContext extends Record<string, unknown> {
	from: { id: number };
	chat: { id: number; type: "private" };
	message: {
		text: string;
		photo?: MockPhoto[];
		document?: MockDocument;
		message_id: number;
		date: number;
		chat: { id: number; type: "private" };
	};
	reply: (text: string, options?: Record<string, unknown>) => Promise<{ message_id: number }>;
	api: {
		raw: {
			sendMessageDraft: (args: MockDraft) => Promise<void>;
		};
		token: string;
		getFile: (fileId: string) => Promise<{ file_path: string }>;
	};
	authState: {
		userId: string;
		isOwner: boolean;
		userConfig: { modes: string[]; defaultMode: string };
	};
	_replies: MockReply[];
	_drafts: MockDraft[];
}

function mockAuthContext(opts: MockAuthContextOptions): MockAuthContext {
	const replies: MockReply[] = [];
	const drafts: MockDraft[] = [];
	const fileMap = opts.fileMap ?? {
		photo: "photo.jpg",
		doc: "notes.txt",
	};

	return {
		from: { id: 123456789 },
		chat: { id: opts.chatId, type: "private" },
		message: {
			text: opts.text ?? "",
			photo: opts.photo,
			document: opts.document,
			message_id: 1,
			date: Date.now(),
			chat: { id: opts.chatId, type: "private" },
		},
		reply: async (text: string, options?: Record<string, unknown>) => {
			replies.push({ text, options });
			return { message_id: replies.length + 1 };
		},
		api: {
			raw: {
				sendMessageDraft: async (args: MockDraft) => {
					drafts.push(args);
				},
			},
			token: "test-bot-token",
			getFile: async (fileId: string) => ({ file_path: fileMap[fileId] ?? "unknown.bin" }),
		},
		authState: {
			userId: "123456789",
			isOwner: true,
			userConfig: { modes: ["telegram-readonly"], defaultMode: "telegram-readonly" },
		},
		_replies: replies,
		_drafts: drafts,
	};
}

function messageUpdate(assistantMessageEvent: AssistantEvent): RpcEvent {
	return { type: "message_update", assistantMessageEvent };
}

async function expectDoneToResolve(streamer: ResponseStreamer): Promise<void> {
	const result = await Promise.race([streamer.done.then(() => "resolved"), Bun.sleep(50).then(() => "timeout")]);
	expect(result).toBe("resolved");
}

describe("bridge streaming", () => {
	it("accumulates text deltas and sends final HTML output", async () => {
		const ctx = mockAuthContext({ chatId: 42 });
		const streamer = new ResponseStreamer(ctx as unknown as AuthContext, true);

		await streamer.handleEvent(messageUpdate({ type: "text_delta", delta: "Hello " }));
		await streamer.handleEvent(messageUpdate({ type: "text_delta", delta: "**Telegram**" }));
		await streamer.handleEvent({ type: "message_end" });

		expect(ctx._replies).toHaveLength(1);
		expect(ctx._replies[0]?.text).toBe(markdownToTelegramHtml("Hello **Telegram**"));
		expect(ctx._replies[0]?.options).toEqual({ parse_mode: "HTML" });
	});

	it("includes tool execution status in message drafts", async () => {
		const ctx = mockAuthContext({ chatId: 43, text: "run" });
		const streamer = new ResponseStreamer(ctx as unknown as AuthContext, true);

		await streamer.handleEvent({
			type: "tool_execution_start",
			toolCallId: "tool-1",
			toolName: "read",
			intent: "file.ts",
		});
		await streamer.handleEvent(messageUpdate({ type: "text_delta", delta: "Done" }));
		await streamer.handleEvent({ type: "message_end" });

		expect(ctx._drafts.some(draft => draft.text.includes("Running: read file.ts"))).toBe(true);
		expect(ctx._replies[0]?.text).toBe(markdownToTelegramHtml("Done"));
	});

	it("uses a one-line thinking summary when thinking output is hidden", async () => {
		const ctx = mockAuthContext({ chatId: 44 });
		const streamer = new ResponseStreamer(ctx as unknown as AuthContext, false);

		await streamer.handleEvent(
			messageUpdate({
				type: "thinking_delta",
				delta: "Analyzing context\nPreparing tool call",
			}),
		);
		await streamer.handleEvent({ type: "message_end" });

		expect(ctx._drafts.some(draft => draft.text.includes("Thinking: Preparing tool call"))).toBe(true);
		expect(ctx._replies[0]?.text).toContain("Last status: Preparing tool call");
	});

	it("splits long responses across multiple Telegram messages", async () => {
		const ctx = mockAuthContext({ chatId: 45 });
		const streamer = new ResponseStreamer(ctx as unknown as AuthContext, true);
		const longText = `${"a".repeat(3000)}\n\n${"b".repeat(3000)}`;

		await streamer.handleEvent(messageUpdate({ type: "text_end", content: longText }));
		await streamer.handleEvent({ type: "message_end" });

		const expectedChunks = splitMessage(markdownToTelegramHtml(longText));
		expect(ctx._replies.map(reply => reply.text)).toEqual(expectedChunks);
		expect(ctx._replies.length).toBeGreaterThan(1);
	});

	it("ignores non-assistant message_end events before the assistant reply arrives", async () => {
		const ctx = mockAuthContext({ chatId: 46 });
		const streamer = new ResponseStreamer(ctx as unknown as AuthContext, true);

		await streamer.handleEvent({
			type: "message_end",
			message: { role: "user", content: [{ type: "text", text: "hi" }] },
		});
		expect(ctx._replies).toHaveLength(0);

		await streamer.handleEvent({
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "Hi." }],
			},
		});

		expect(ctx._replies[0]?.text).toBe(markdownToTelegramHtml("Hi."));
		expect(ctx._replies[0]?.options).toEqual({ parse_mode: "HTML" });
	});

	it("uses final message_end text when the provider omits text delta events", async () => {
		const ctx = mockAuthContext({ chatId: 46 });
		const streamer = new ResponseStreamer(ctx as unknown as AuthContext, true);

		await streamer.handleEvent({
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "Hi." }],
			},
		});

		expect(ctx._replies[0]?.text).toBe(markdownToTelegramHtml("Hi."));
		expect(ctx._replies[0]?.options).toEqual({ parse_mode: "HTML" });
	});

	it("waits for the final assistant message after toolUse segments", async () => {
		const ctx = mockAuthContext({ chatId: 46 });
		const streamer = new ResponseStreamer(ctx as unknown as AuthContext, true);

		await streamer.handleEvent({
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "toolUse",
				content: [{ type: "text", text: "Let me inspect" }, { type: "toolCall" }],
			},
		});
		expect(ctx._replies).toHaveLength(0);

		await streamer.handleEvent({
			type: "message_end",
			message: { role: "toolResult", content: [{ type: "text", text: "Read one file" }] },
		});
		expect(ctx._replies).toHaveLength(0);

		await streamer.handleEvent({
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "the repo and fix it." }],
			},
		});

		expect(ctx._replies[0]?.text).toBe(markdownToTelegramHtml("Let me inspect the repo and fix it."));
		expect(ctx._replies[0]?.options).toEqual({ parse_mode: "HTML" });
	});

	it("sends fallback summary when response has no assistant text", async () => {
		const ctx = mockAuthContext({ chatId: 46 });
		const streamer = new ResponseStreamer(ctx as unknown as AuthContext, true);

		await streamer.handleEvent({
			type: "tool_execution_start",
			toolCallId: "tool-2",
			toolName: "grep",
			intent: "project",
		});
		await streamer.handleEvent({
			type: "tool_execution_end",
			toolCallId: "tool-2",
			toolName: "grep",
			isError: false,
		});
		await streamer.handleEvent({ type: "agent_end" });

		expect(ctx._replies[0]?.text).toContain("Tool activity:");
		expect(ctx._replies[0]?.text).toContain("Running: grep project");
	});

	it("surfaces failed prompt responses instead of the empty-response fallback", async () => {
		const ctx = mockAuthContext({ chatId: 47 });
		const streamer = new ResponseStreamer(ctx as unknown as AuthContext, true);

		await streamer.handleEvent({ type: "response", command: "prompt", success: false, error: "No model selected" });

		expect(ctx._replies[0]?.text).toContain("Assistant error: No model selected");
		expect(ctx._replies[0]?.options).toEqual({ parse_mode: "HTML" });
	});

	it("surfaces assistant message_end errors instead of the empty-response fallback", async () => {
		const ctx = mockAuthContext({ chatId: 48 });
		const streamer = new ResponseStreamer(ctx as unknown as AuthContext, true);

		await streamer.handleEvent({
			type: "message_end",
			message: { role: "assistant", stopReason: "error", errorMessage: "Invalid API key" },
		});

		expect(ctx._replies[0]?.text).toContain("Assistant error: Invalid API key");
		expect(ctx._replies[0]?.options).toEqual({ parse_mode: "HTML" });
	});

	it("forwards RPC error events to Telegram chat", async () => {
		const ctx = mockAuthContext({ chatId: 47 });
		const streamer = new ResponseStreamer(ctx as unknown as AuthContext, true);

		await streamer.handleEvent({ type: "error", message: "Process crashed" });

		expect(ctx._replies[0]?.text).toBe("RPC error: Process crashed");
	});

	it("cancel resolves done even before terminal events", async () => {
		const ctx = mockAuthContext({ chatId: 48 });
		const streamer = new ResponseStreamer(ctx as unknown as AuthContext, true);
		const cancel = (streamer as unknown as { cancel?: () => void }).cancel;

		expect(typeof cancel).toBe("function");
		cancel?.call(streamer);
		await expectDoneToResolve(streamer);
	});

	it("cancel remains idempotent after finalization", async () => {
		const ctx = mockAuthContext({ chatId: 49 });
		const streamer = new ResponseStreamer(ctx as unknown as AuthContext, true);
		const cancel = (streamer as unknown as { cancel?: () => void }).cancel;

		await streamer.handleEvent(messageUpdate({ type: "text_end", content: "hello" }));
		await streamer.handleEvent({ type: "message_end" });
		expect(typeof cancel).toBe("function");
		cancel?.call(streamer);
		cancel?.call(streamer);
		await expectDoneToResolve(streamer);
		expect(ctx._replies).toHaveLength(1);
	});

	it("resolves done when final reply throws", async () => {
		const ctx = mockAuthContext({ chatId: 50 });
		let replyCalls = 0;
		const streamer = new ResponseStreamer(
			{
				...ctx,
				reply: async () => {
					replyCalls += 1;
					throw new Error("reply failed");
				},
			} as unknown as AuthContext,
			true,
		);

		await streamer.handleEvent(messageUpdate({ type: "text_end", content: "hello" }));
		await expect(streamer.handleEvent({ type: "message_end" })).rejects.toThrow("reply failed");
		await expectDoneToResolve(streamer);
		expect(replyCalls).toBe(1);
	});

	it("awaitStreamerCompletion waits for natural completion", async () => {
		const deferred = Promise.withResolvers<void>();
		let cancelCalls = 0;

		setTimeout(() => deferred.resolve(), 10);
		await awaitStreamerCompletion(
			{
				done: deferred.promise,
				cancel: () => {
					cancelCalls += 1;
				},
			},
			50,
		);

		expect(cancelCalls).toBe(0);
	});

	it("awaitStreamerCompletion cancels stalled streamers", async () => {
		const deferred = Promise.withResolvers<void>();
		let cancelCalls = 0;

		await awaitStreamerCompletion(
			{
				done: deferred.promise,
				cancel: () => {
					cancelCalls += 1;
					deferred.resolve();
				},
			},
			5,
		);

		expect(cancelCalls).toBe(1);
	});

	it("cancel remains idempotent after error events", async () => {
		const ctx = mockAuthContext({ chatId: 51 });
		const streamer = new ResponseStreamer(ctx as unknown as AuthContext, true);
		const cancel = (streamer as unknown as { cancel?: () => void }).cancel;

		await streamer.handleEvent({ type: "error", message: "Process crashed" });
		expect(typeof cancel).toBe("function");
		cancel?.call(streamer);
		cancel?.call(streamer);
		await expectDoneToResolve(streamer);
		expect(ctx._replies).toHaveLength(1);
	});
});

describe("telegram to rpc bridge", () => {
	it("prepends document content and includes downloaded image payloads", async () => {
		const ctx = mockAuthContext({
			chatId: 60,
			text: "Please review",
			photo: [
				{ file_id: "photo-small", file_size: 100 },
				{ file_id: "photo-large", file_size: 300 },
			],
			document: { file_id: "doc", file_name: "notes.txt", mime_type: "text/plain" },
			fileMap: {
				"photo-small": "small.jpg",
				"photo-large": "large.jpg",
				doc: "notes.txt",
			},
		});

		const prompts: Array<{ message: string; images?: ImageContentRef[] }> = [];
		const rpcClient = {
			prompt: async (message: string, images?: ImageContentRef[]) => {
				prompts.push({ message, images });
			},
		} as unknown as RpcClient;

		using _hook = hookFetch(input => {
			const url = String(input);
			if (url.includes("/large.jpg")) {
				return new Response(new Uint8Array([1, 2, 3]), {
					status: 200,
					headers: { "content-type": "image/jpeg" },
				});
			}
			if (url.includes("/notes.txt")) {
				return new Response("line 1\nline 2", {
					status: 200,
					headers: { "content-type": "text/plain" },
				});
			}
			return new Response("missing", { status: 404 });
		});

		await handleTelegramMessage(ctx as unknown as AuthContext, rpcClient);

		expect(prompts).toHaveLength(1);
		expect(prompts[0]?.message).toContain("Attached file (notes.txt):");
		expect(prompts[0]?.message).toContain("line 1");
		expect(prompts[0]?.message).toContain("Please review");
		expect(prompts[0]?.images).toEqual([
			{
				type: "base64",
				media_type: "image/jpeg",
				data: "AQID",
			},
		]);
		expect(ctx._replies).toHaveLength(0);
	});

	it("skips image attachments when image download fails", async () => {
		const ctx = mockAuthContext({
			chatId: 61,
			text: "No image please",
			photo: [{ file_id: "photo-fail", file_size: 200 }],
			fileMap: { "photo-fail": "fail.jpg" },
		});

		const prompts: Array<{ message: string; images?: ImageContentRef[] }> = [];
		const rpcClient = {
			prompt: async (message: string, images?: ImageContentRef[]) => {
				prompts.push({ message, images });
			},
		} as unknown as RpcClient;

		using _hook = hookFetch(() => new Response("failed", { status: 500 }));

		await handleTelegramMessage(ctx as unknown as AuthContext, rpcClient);

		expect(prompts).toHaveLength(1);
		expect(prompts[0]?.message).toBe("No image please");
		expect(prompts[0]?.images).toBeUndefined();
		expect(ctx._replies).toHaveLength(0);
	});
});

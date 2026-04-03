import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hookFetch } from "@oh-my-pi/pi-utils";
import type { RpcClient } from "../../src/rpc/rpc-client";
import type { AssistantEvent, ImageContentRef, RpcEvent } from "../../src/rpc/types";
import type { AuthContext } from "../../src/telegram/bot/auth";
import { markdownToTelegramHtml } from "../../src/telegram/bridge/markdown-html";
import { splitMessage } from "../../src/telegram/bridge/message-splitter";
import { awaitStreamerCompletion, ResponseStreamer } from "../../src/telegram/bridge/rpc-to-telegram";
import {
	detectImageTypeFromBytes,
	handleTelegramMessage,
	normalizeImageMediaType,
	VALID_IMAGE_MEDIA_TYPES,
} from "../../src/telegram/bridge/telegram-to-rpc";

interface MockReply {
	text: string;
	options?: Record<string, unknown>;
}

interface MockDraft {
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
	replyWithDraft: (text: string) => Promise<true>;
	replyWithChatAction: (action: string) => Promise<true>;
	api: {
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
	_chatActions: string[];
	_documents: Array<{ file: unknown; options?: Record<string, unknown> }>;
	_photos: Array<{ file: unknown; options?: Record<string, unknown> }>;
	replyWithDocument: (file: unknown, options?: Record<string, unknown>) => Promise<{ message_id: number }>;
	replyWithPhoto: (file: unknown, options?: Record<string, unknown>) => Promise<{ message_id: number }>;
}
function mockAuthContext(opts: MockAuthContextOptions): MockAuthContext {
	const replies: MockReply[] = [];
	const drafts: MockDraft[] = [];
	const chatActions: string[] = [];
	const documents: Array<{ file: unknown; options?: Record<string, unknown> }> = [];
	const photos: Array<{ file: unknown; options?: Record<string, unknown> }> = [];
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
		replyWithDraft: async (text: string) => {
			drafts.push({ text });
			return true as const;
		},
		replyWithChatAction: async (action: string) => {
			chatActions.push(action);
			return true as const;
		},
		replyWithDocument: async (file: unknown, options?: Record<string, unknown>) => {
			documents.push({ file, options });
			return { message_id: documents.length + 100 };
		},
		replyWithPhoto: async (file: unknown, options?: Record<string, unknown>) => {
			photos.push({ file, options });
			return { message_id: photos.length + 200 };
		},
		api: {
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
		_chatActions: chatActions,
		_documents: documents,
		_photos: photos,
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

	it("surfaces tool execution updates in drafts and fallback summaries", async () => {
		const ctx = mockAuthContext({ chatId: 43, text: "run" });
		const streamer = new ResponseStreamer(ctx as unknown as AuthContext, true);

		await streamer.handleEvent({
			type: "tool_execution_start",
			toolCallId: "tool-1",
			toolName: "read",
			intent: "inspect config",
		});
		await streamer.handleEvent({
			type: "tool_execution_update",
			toolCallId: "tool-1",
			toolName: "read",
			partialResult: {
				content: [{ type: "text", text: "src/config/server.kdl\nsrc/config/channels.kdl" }],
			},
		} as unknown as RpcEvent);
		await streamer.handleEvent({ type: "agent_end" });

		expect(ctx._drafts.some(draft => draft.text.includes("src/config/channels.kdl"))).toBe(true);
		expect(ctx._replies[0]?.text).toContain("src/config/channels.kdl");
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

	it("sends typing action immediately on construction", async () => {
		const ctx = mockAuthContext({ chatId: 52 });
		const streamer = new ResponseStreamer(ctx as unknown as AuthContext, true);

		// Typing action fires synchronously (via fire-and-forget promise) during construction
		// Flush the microtask queue so the mock records it
		await Bun.sleep(0);
		expect(ctx._chatActions.length).toBeGreaterThanOrEqual(1);
		expect(ctx._chatActions[0]).toBe("typing");

		await streamer.handleEvent(messageUpdate({ type: "text_end", content: "done" }));
		await streamer.handleEvent({ type: "message_end" });
	});

	it("clears typing interval on cancel without leaks", async () => {
		const ctx = mockAuthContext({ chatId: 53 });
		const streamer = new ResponseStreamer(ctx as unknown as AuthContext, true);
		await Bun.sleep(0);
		const actionsBefore = ctx._chatActions.length;

		streamer.cancel();
		await expectDoneToResolve(streamer);

		// After cancel + wait, no new typing actions should fire
		await Bun.sleep(50);
		expect(ctx._chatActions.length).toBe(actionsBefore);
	});

	it("clears typing interval on error event without leaks", async () => {
		const ctx = mockAuthContext({ chatId: 54 });
		const streamer = new ResponseStreamer(ctx as unknown as AuthContext, true);
		await Bun.sleep(0);
		const actionsBefore = ctx._chatActions.length;

		await streamer.handleEvent({ type: "error", message: "Process crashed" });
		await expectDoneToResolve(streamer);

		// After error + wait, no new typing actions should fire
		await Bun.sleep(50);
		expect(ctx._chatActions.length).toBe(actionsBefore);
	});
});

describe("file delivery", () => {
	it("delivers document via replyWithDocument for send_file", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-test-"));
		const testFile = path.join(tmpDir, "report.pdf");
		await Bun.write(testFile, "fake pdf content");

		try {
			const ctx = mockAuthContext({ chatId: 100 });
			const streamer = new ResponseStreamer(ctx as unknown as AuthContext, false);

			await streamer.handleEvent({
				type: "tool_execution_end",
				toolCallId: "tc-1",
				toolName: "send_file",
				isError: false,
				result: {
					content: [{ type: "text", text: "File queued" }],
					details: {
						delivery: {
							type: "document",
							absolutePath: testFile,
							fileName: "report.pdf",
							mimeType: "application/pdf",
							caption: "Monthly report",
							fileSize: 16,
						},
					},
				},
			});

			expect(ctx._documents).toHaveLength(1);
			expect(ctx._documents[0]?.options?.caption).toBe("Monthly report");
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("delivers photo via replyWithPhoto for send_file with photo type", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-test-"));
		const testFile = path.join(tmpDir, "image.png");
		await Bun.write(testFile, "fake png");

		try {
			const ctx = mockAuthContext({ chatId: 101 });
			const streamer = new ResponseStreamer(ctx as unknown as AuthContext, false);

			await streamer.handleEvent({
				type: "tool_execution_end",
				toolCallId: "tc-2",
				toolName: "send_file",
				isError: false,
				result: {
					content: [{ type: "text", text: "File queued" }],
					details: {
						delivery: {
							type: "photo",
							absolutePath: testFile,
							fileName: "image.png",
							mimeType: "image/png",
							fileSize: 8,
						},
					},
				},
			});

			expect(ctx._photos).toHaveLength(1);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("does not deliver file on error", async () => {
		const ctx = mockAuthContext({ chatId: 102 });
		const streamer = new ResponseStreamer(ctx as unknown as AuthContext, false);

		await streamer.handleEvent({
			type: "tool_execution_end",
			toolCallId: "tc-3",
			toolName: "send_file",
			isError: true,
			result: { content: [{ type: "text", text: "Error" }] },
		});

		expect(ctx._documents).toHaveLength(0);
		expect(ctx._photos).toHaveLength(0);
	});

	it("does not crash when delivery details are missing", async () => {
		const ctx = mockAuthContext({ chatId: 103 });
		const streamer = new ResponseStreamer(ctx as unknown as AuthContext, false);

		await streamer.handleEvent({
			type: "tool_execution_end",
			toolCallId: "tc-4",
			toolName: "send_file",
			isError: false,
			result: { content: [{ type: "text", text: "No details" }] },
		});

		expect(ctx._documents).toHaveLength(0);
		expect(ctx._photos).toHaveLength(0);
	});

	it("auto-sends generated images when autoSendImages is true", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-test-"));
		const img1 = path.join(tmpDir, "gen1.png");
		const img2 = path.join(tmpDir, "gen2.png");
		await Bun.write(img1, "image1");
		await Bun.write(img2, "image2");

		try {
			const ctx = mockAuthContext({ chatId: 104 });
			const streamer = new ResponseStreamer(ctx as unknown as AuthContext, false, true);

			await streamer.handleEvent({
				type: "tool_execution_end",
				toolCallId: "tc-5",
				toolName: "generate_image",
				isError: false,
				result: {
					content: [{ type: "text", text: "Generated" }],
					details: { imagePaths: [img1, img2] },
				},
			});

			expect(ctx._photos).toHaveLength(2);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("does not auto-send generated images when autoSendImages is false", async () => {
		const ctx = mockAuthContext({ chatId: 105 });
		const streamer = new ResponseStreamer(ctx as unknown as AuthContext, false, false);

		await streamer.handleEvent({
			type: "tool_execution_end",
			toolCallId: "tc-6",
			toolName: "generate_image",
			isError: false,
			result: {
				content: [{ type: "text", text: "Generated" }],
				details: { imagePaths: ["/tmp/nonexistent.png"] },
			},
		});

		expect(ctx._photos).toHaveLength(0);
	});

	it("handles missing imagePaths gracefully", async () => {
		const ctx = mockAuthContext({ chatId: 106 });
		const streamer = new ResponseStreamer(ctx as unknown as AuthContext, false, true);

		await streamer.handleEvent({
			type: "tool_execution_end",
			toolCallId: "tc-7",
			toolName: "generate_image",
			isError: false,
			result: {
				content: [{ type: "text", text: "Generated" }],
				details: { imageCount: 0, imagePaths: [] },
			},
		});

		expect(ctx._photos).toHaveLength(0);
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
				type: "image",
				mimeType: "image/jpeg",
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
	it("includes non-text file uploads as attachment context when no text is provided", async () => {
		const ctx = mockAuthContext({
			chatId: 62,
			document: { file_id: "doc-binary", file_name: "payload.bin", mime_type: "application/octet-stream" },
			fileMap: { "doc-binary": "payload.bin" },
		});

		const prompts: Array<{ message: string; images?: ImageContentRef[] }> = [];
		const rpcClient = {
			prompt: async (message: string, images?: ImageContentRef[]) => {
				prompts.push({ message, images });
			},
		} as unknown as RpcClient;

		using _hook = hookFetch(input => {
			const url = String(input);
			if (url.includes("/payload.bin")) {
				return new Response(new Uint8Array([0, 159, 255, 12]), {
					status: 200,
					headers: { "content-type": "application/octet-stream" },
				});
			}
			return new Response("missing", { status: 404 });
		});

		await handleTelegramMessage(ctx as unknown as AuthContext, rpcClient);

		expect(prompts).toHaveLength(1);
		expect(prompts[0]?.message).toContain("Attached file (payload.bin): Unable to parse as text.");
		expect(prompts[0]?.message).toContain("mime=application/octet-stream");
		expect(prompts[0]?.message).toContain("size=4 bytes");
		expect(prompts[0]?.message).not.toBe("User sent an empty message.");
		expect(prompts[0]?.images).toBeUndefined();
	});

	it("surfaces attachment metadata when document download fails", async () => {
		const ctx = mockAuthContext({
			chatId: 63,
			document: { file_id: "doc-missing", file_name: "missing.pdf", mime_type: "application/pdf" },
			fileMap: { "doc-missing": "missing.pdf" },
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
		expect(prompts[0]?.message).toContain("Attached file (missing.pdf): Failed to download attachment.");
		expect(prompts[0]?.message).toContain("mime=application/pdf");
		expect(prompts[0]?.message).toContain("size=0 bytes");
		expect(prompts[0]?.message).not.toBe("User sent an empty message.");
		expect(prompts[0]?.images).toBeUndefined();
	});

	it("uses attachment summary for oversized text file uploads", async () => {
		const oversizedBytes = new Uint8Array(512 * 1024 + 1);
		oversizedBytes.fill(65);

		const ctx = mockAuthContext({
			chatId: 64,
			document: { file_id: "doc-large", file_name: "large.txt", mime_type: "text/plain" },
			fileMap: { "doc-large": "large.txt" },
		});

		const prompts: Array<{ message: string; images?: ImageContentRef[] }> = [];
		const rpcClient = {
			prompt: async (message: string, images?: ImageContentRef[]) => {
				prompts.push({ message, images });
			},
		} as unknown as RpcClient;

		using _hook = hookFetch(input => {
			const url = String(input);
			if (url.includes("/large.txt")) {
				return new Response(oversizedBytes, {
					status: 200,
					headers: { "content-type": "text/plain" },
				});
			}
			return new Response("missing", { status: 404 });
		});

		await handleTelegramMessage(ctx as unknown as AuthContext, rpcClient);

		expect(prompts).toHaveLength(1);
		expect(prompts[0]?.message).toContain("Attached file (large.txt): Unable to inline due to size limit.");
		expect(prompts[0]?.message).toContain("mime=text/plain");
		expect(prompts[0]?.message).toContain(`size=${oversizedBytes.length} bytes`);
		expect(prompts[0]?.images).toBeUndefined();
	});
});

describe("detectImageTypeFromBytes", () => {
	it("detects JPEG from magic bytes", () => {
		const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
		expect(detectImageTypeFromBytes(bytes)).toBe("image/jpeg");
	});

	it("detects PNG from magic bytes", () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
		expect(detectImageTypeFromBytes(bytes)).toBe("image/png");
	});

	it("detects GIF from magic bytes", () => {
		const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
		expect(detectImageTypeFromBytes(bytes)).toBe("image/gif");
	});

	it("detects WebP from magic bytes", () => {
		// RIFF....WEBP
		const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
		expect(detectImageTypeFromBytes(bytes)).toBe("image/webp");
	});

	it("returns null for empty bytes", () => {
		expect(detectImageTypeFromBytes(new Uint8Array([]))).toBeNull();
	});

	it("returns null for unknown/short bytes", () => {
		expect(detectImageTypeFromBytes(new Uint8Array([0x00, 0x01]))).toBeNull();
	});

	it("returns null for truncated PNG header", () => {
		// Only 4 bytes of PNG header instead of 8
		expect(detectImageTypeFromBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
	});
});

describe("normalizeImageMediaType", () => {
	const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
	const unknownBytes = new Uint8Array([0x00, 0x01, 0x02]);

	it("passes through valid image/jpeg", () => {
		expect(normalizeImageMediaType(jpegBytes, "image/jpeg", "image/jpeg")).toBe("image/jpeg");
	});

	it("passes through valid image/png", () => {
		expect(normalizeImageMediaType(unknownBytes, "image/png", "image/jpeg")).toBe("image/png");
	});

	it("passes through valid image/gif", () => {
		expect(normalizeImageMediaType(unknownBytes, "image/gif", "image/jpeg")).toBe("image/gif");
	});

	it("passes through valid image/webp", () => {
		expect(normalizeImageMediaType(unknownBytes, "image/webp", "image/jpeg")).toBe("image/webp");
	});

	it("strips charset suffix before checking", () => {
		expect(normalizeImageMediaType(unknownBytes, "image/png; charset=utf-8", "image/jpeg")).toBe("image/png");
	});

	it("normalizes case", () => {
		expect(normalizeImageMediaType(unknownBytes, "Image/JPEG", "image/jpeg")).toBe("image/jpeg");
	});

	it("detects from bytes when header is application/octet-stream", () => {
		expect(normalizeImageMediaType(jpegBytes, "application/octet-stream", "image/jpeg")).toBe("image/jpeg");
	});

	it("falls back when header is generic and bytes are unrecognized", () => {
		expect(normalizeImageMediaType(unknownBytes, "application/octet-stream", "image/jpeg")).toBe("image/jpeg");
	});

	it("falls back when header is a non-image type", () => {
		expect(normalizeImageMediaType(unknownBytes, "text/html", "image/jpeg")).toBe("image/jpeg");
	});
});

describe("VALID_IMAGE_MEDIA_TYPES", () => {
	it("contains exactly the four Anthropic-accepted types", () => {
		expect(VALID_IMAGE_MEDIA_TYPES).toEqual(new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]));
	});
});

describe("telegram to rpc bridge — image media type normalization", () => {
	it("normalizes application/octet-stream to image/jpeg via magic bytes", async () => {
		// JPEG magic bytes: FF D8 FF
		const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

		const ctx = mockAuthContext({
			chatId: 70,
			text: "Describe this image",
			photo: [{ file_id: "photo-octet", file_size: 500 }],
			fileMap: { "photo-octet": "photo.jpg" },
		});

		const prompts: Array<{ message: string; images?: ImageContentRef[] }> = [];
		const rpcClient = {
			prompt: async (message: string, images?: ImageContentRef[]) => {
				prompts.push({ message, images });
			},
		} as unknown as RpcClient;

		using _hook = hookFetch(input => {
			const url = String(input);
			if (url.includes("/photo.jpg")) {
				return new Response(jpegBytes, {
					status: 200,
					headers: { "content-type": "application/octet-stream" },
				});
			}
			return new Response("missing", { status: 404 });
		});

		await handleTelegramMessage(ctx as unknown as AuthContext, rpcClient);

		expect(prompts).toHaveLength(1);
		expect(prompts[0]?.images).toHaveLength(1);
		expect(prompts[0]?.images?.[0]?.mimeType).toBe("image/jpeg");
	});

	it("normalizes application/octet-stream to image/png when bytes are PNG", async () => {
		const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

		const ctx = mockAuthContext({
			chatId: 71,
			text: "What is this?",
			photo: [{ file_id: "photo-png", file_size: 400 }],
			fileMap: { "photo-png": "photo.png" },
		});

		const prompts: Array<{ message: string; images?: ImageContentRef[] }> = [];
		const rpcClient = {
			prompt: async (message: string, images?: ImageContentRef[]) => {
				prompts.push({ message, images });
			},
		} as unknown as RpcClient;

		using _hook = hookFetch(input => {
			const url = String(input);
			if (url.includes("/photo.png")) {
				return new Response(pngBytes, {
					status: 200,
					headers: { "content-type": "application/octet-stream" },
				});
			}
			return new Response("missing", { status: 404 });
		});

		await handleTelegramMessage(ctx as unknown as AuthContext, rpcClient);

		expect(prompts).toHaveLength(1);
		expect(prompts[0]?.images).toHaveLength(1);
		expect(prompts[0]?.images?.[0]?.mimeType).toBe("image/png");
	});

	it("preserves valid image/jpeg content-type without modification", async () => {
		const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe1]);

		const ctx = mockAuthContext({
			chatId: 72,
			text: "Check this",
			photo: [{ file_id: "photo-valid", file_size: 300 }],
			fileMap: { "photo-valid": "good.jpg" },
		});

		const prompts: Array<{ message: string; images?: ImageContentRef[] }> = [];
		const rpcClient = {
			prompt: async (message: string, images?: ImageContentRef[]) => {
				prompts.push({ message, images });
			},
		} as unknown as RpcClient;

		using _hook = hookFetch(input => {
			const url = String(input);
			if (url.includes("/good.jpg")) {
				return new Response(jpegBytes, {
					status: 200,
					headers: { "content-type": "image/jpeg" },
				});
			}
			return new Response("missing", { status: 404 });
		});

		await handleTelegramMessage(ctx as unknown as AuthContext, rpcClient);

		expect(prompts).toHaveLength(1);
		expect(prompts[0]?.images).toHaveLength(1);
		expect(prompts[0]?.images?.[0]?.mimeType).toBe("image/jpeg");
	});
});

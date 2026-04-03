import { afterEach, describe, expect, it, mock, vi } from "bun:test";
import { logger } from "@oh-my-pi/pi-utils";
import type { AuthContext } from "../../src/telegram/bot/auth";
import {
	ResponseStreamer,
	resolveVoiceReply,
	type VoiceReplyDecision,
} from "../../src/telegram/bridge/rpc-to-telegram";
import type { TtsProvider, TtsResult } from "../../src/telegram/voice";

interface MockReply {
	text: string;
	options?: Record<string, unknown>;
}

interface MockVoiceReply {
	file: unknown;
}

interface MockAuthContext extends Record<string, unknown> {
	chat: { id: number; type: "private" };
	message: { chat: { id: number; type: "private" } };
	reply: (text: string, options?: Record<string, unknown>) => Promise<{ message_id: number }>;
	replyWithDraft: (text: string) => Promise<true>;
	replyWithChatAction: (action: string) => Promise<true>;
	replyWithVoice: (file: unknown) => Promise<{ message_id: number }>;
	_replies: MockReply[];
	_drafts: string[];
	_chatActions: string[];
	_voices: MockVoiceReply[];
}

function createMockCtx(): MockAuthContext {
	const replies: MockReply[] = [];
	const drafts: string[] = [];
	const chatActions: string[] = [];
	const voices: MockVoiceReply[] = [];

	return {
		chat: { id: 42, type: "private" },
		message: { chat: { id: 42, type: "private" } },
		reply: async (text: string, options?: Record<string, unknown>) => {
			replies.push({ text, options });
			return { message_id: replies.length };
		},
		replyWithDraft: async (text: string) => {
			drafts.push(text);
			return true as const;
		},
		replyWithChatAction: async (action: string) => {
			chatActions.push(action);
			return true as const;
		},
		replyWithVoice: async (file: unknown) => {
			voices.push({ file });
			return { message_id: voices.length + 100 };
		},
		_replies: replies,
		_drafts: drafts,
		_chatActions: chatActions,
		_voices: voices,
	};
}

function createTtsProvider(
	impl: (text: string, options?: { voice?: string }) => Promise<TtsResult>,
): TtsProvider & { synthesize: ReturnType<typeof mock<typeof impl>> } {
	const synthesize = mock(impl);
	return { synthesize };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("resolveVoiceReply", () => {
	it("returns voice for mirror mode when the incoming message was voice", () => {
		expect(
			resolveVoiceReply({
				globalMode: "mirror",
				incomingWasVoice: true,
			}),
		).toBe("voice");
	});

	it("returns text for mirror mode when the incoming message was text", () => {
		expect(
			resolveVoiceReply({
				globalMode: "mirror",
				incomingWasVoice: false,
			}),
		).toBe("text");
	});

	it("returns voice for always mode regardless of input type", () => {
		expect(resolveVoiceReply({ globalMode: "always", incomingWasVoice: true })).toBe("voice");
		expect(resolveVoiceReply({ globalMode: "always", incomingWasVoice: false })).toBe("voice");
	});

	it("returns text for never mode regardless of input type", () => {
		expect(resolveVoiceReply({ globalMode: "never", incomingWasVoice: true })).toBe("text");
		expect(resolveVoiceReply({ globalMode: "never", incomingWasVoice: false })).toBe("text");
	});

	it("prefers session override over user mode", () => {
		expect(
			resolveVoiceReply({
				globalMode: "never",
				userMode: "always",
				sessionOverride: "mirror",
				incomingWasVoice: false,
			}),
		).toBe("text");
	});

	it("prefers user mode over global mode", () => {
		expect(
			resolveVoiceReply({
				globalMode: "never",
				userMode: "always",
				incomingWasVoice: false,
			}),
		).toBe("voice");
	});

	it("prefers session override over global mode", () => {
		expect(
			resolveVoiceReply({
				globalMode: "always",
				sessionOverride: "never",
				incomingWasVoice: true,
			}),
		).toBe("text");
	});
});

describe("ResponseStreamer voice replies", () => {
	async function finalizeWithText(options: {
		voiceReplyDecision: VoiceReplyDecision;
		ttsProvider?: TtsProvider | null;
		ttsVoice?: string;
		text?: string;
		draftHeader?: string;
	}): Promise<MockAuthContext> {
		const ctx = createMockCtx();
		const streamer = new ResponseStreamer(
			ctx as unknown as AuthContext,
			false,
			true,
			options.ttsProvider,
			options.voiceReplyDecision,
			options.draftHeader,
			options.ttsVoice,
		);
		const text = options.text ?? "Hello from assistant";
		if (text) {
			await streamer.handleEvent({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: text },
			});
		}
		await streamer.handleEvent({ type: "message_end" });
		await streamer.done;
		return ctx;
	}

	it("synthesizes and sends voice after sending text when voice replies are enabled", async () => {
		const ttsProvider = createTtsProvider(async () => ({
			audio: Buffer.from([1, 2, 3]),
			mimeType: "audio/ogg",
		}));

		const ctx = await finalizeWithText({
			voiceReplyDecision: "voice",
			ttsProvider,
			ttsVoice: "alloy",
		});

		expect(ctx._replies).toHaveLength(1);
		expect(ttsProvider.synthesize).toHaveBeenCalledWith("Hello from assistant", { voice: "alloy" });
		expect(ctx._voices).toHaveLength(1);
	});

	it("skips synthesis when text replies are selected", async () => {
		const ttsProvider = createTtsProvider(async () => ({
			audio: Buffer.from([1]),
			mimeType: "audio/ogg",
		}));

		const ctx = await finalizeWithText({
			voiceReplyDecision: "text",
			ttsProvider,
		});

		expect(ttsProvider.synthesize).not.toHaveBeenCalled();
		expect(ctx._voices).toHaveLength(0);
		expect(ctx._replies).toHaveLength(1);
	});

	it("falls back to text-only when synthesis fails", async () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const ttsProvider = createTtsProvider(async () => {
			throw new Error("tts offline");
		});

		const ctx = await finalizeWithText({
			voiceReplyDecision: "voice",
			ttsProvider,
		});

		expect(ctx._replies).toHaveLength(1);
		expect(ctx._voices).toHaveLength(0);
		expect(warnSpy).toHaveBeenCalledWith("TTS synthesis failed, falling back to text-only", {
			error: "Error: tts offline",
		});
	});

	it("skips synthesis for empty assistant text", async () => {
		const ttsProvider = createTtsProvider(async () => ({
			audio: Buffer.from([1]),
			mimeType: "audio/ogg",
		}));

		const ctx = await finalizeWithText({
			voiceReplyDecision: "voice",
			ttsProvider,
			text: "",
		});

		expect(ttsProvider.synthesize).not.toHaveBeenCalled();
		expect(ctx._voices).toHaveLength(0);
		expect(ctx._replies).toHaveLength(1);
	});

	it("prepends the draft header before streamed text", async () => {
		const ctx = createMockCtx();
		const streamer = new ResponseStreamer(
			ctx as unknown as AuthContext,
			false,
			true,
			null,
			"text",
			"[Voice message received]",
		);

		await streamer.handleEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "Transcribed reply" },
		});

		expect(ctx._drafts[0]).toContain("[Voice message received]");
		expect(ctx._drafts[0]).toContain("Transcribed reply");
	});
});

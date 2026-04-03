import { beforeEach, describe, expect, it, mock } from "bun:test";
import { hookFetch } from "@oh-my-pi/pi-utils";
import type { VoiceConfig } from "../../src/config/types";
import type { RpcClient } from "../../src/rpc/rpc-client";
import type { AuthContext } from "../../src/telegram/bot/auth";
import type { SttProvider } from "../../src/telegram/voice";

const extractAudioFromVideo = mock(
	async (video: Buffer): Promise<Buffer> => Buffer.concat([Buffer.from("ogg:"), video]),
);

mock.module("../../src/telegram/voice", () => ({
	extractAudioFromVideo,
}));

interface MockFileRef {
	file_id: string;
	mime_type?: string;
	file_name?: string;
}

interface MockAuthContextOptions {
	chatId?: number;
	text?: string;
	caption?: string;
	voice?: MockFileRef;
	video_note?: MockFileRef;
	audio?: MockFileRef;
	document?: MockFileRef;
	fileMap?: Record<string, string>;
}

interface MockAuthContext extends Record<string, unknown> {
	chat: { id: number; type: "private" };
	message: {
		text?: string;
		caption?: string;
		voice?: MockFileRef;
		video_note?: MockFileRef;
		audio?: MockFileRef;
		document?: MockFileRef;
		message_id: number;
		date: number;
		chat: { id: number; type: "private" };
	};
	reply: (text: string) => Promise<{ message_id: number }>;
	api: {
		token: string;
		getFile: (fileId: string) => Promise<{ file_path: string }>;
	};
	authState: {
		userId: string;
		isOwner: boolean;
		userConfig: { modes: string[]; defaultMode: string };
	};
	_replies: string[];
}

function createVoiceConfig(): VoiceConfig {
	return {
		replyMode: "mirror",
		stt: {
			provider: "openai",
			apiKey: "test-key", // pragma: allowlist secret
			model: "whisper-1",
			language: "en",
		},
	};
}

function createMockCtx(options: MockAuthContextOptions): MockAuthContext {
	const replies: string[] = [];
	const chatId = options.chatId ?? 1;
	const fileMap = options.fileMap ?? {};
	return {
		chat: { id: chatId, type: "private" },
		message: {
			text: options.text,
			caption: options.caption,
			voice: options.voice,
			video_note: options.video_note,
			audio: options.audio,
			document: options.document,
			message_id: 1,
			date: Date.now(),
			chat: { id: chatId, type: "private" },
		},
		reply: async (text: string) => {
			replies.push(text);
			return { message_id: replies.length };
		},
		api: {
			token: "test-bot-token",
			getFile: async (fileId: string) => ({ file_path: fileMap[fileId] ?? `${fileId}.bin` }),
		},
		authState: {
			userId: "user-1",
			isOwner: true,
			userConfig: { modes: ["telegram-readonly"], defaultMode: "telegram-readonly" },
		},
		_replies: replies,
	};
}

async function loadBridgeModule() {
	return import("../../src/telegram/bridge/telegram-to-rpc");
}

beforeEach(() => {
	extractAudioFromVideo.mockClear();
});

describe("incoming voice transcription", () => {
	it("sends voice transcription to RPC for Telegram voice messages", async () => {
		const { handleTelegramMessage } = await loadBridgeModule();
		const ctx = createMockCtx({
			voice: { file_id: "voice-1", mime_type: "audio/ogg" },
			fileMap: { "voice-1": "voice.ogg" },
		});
		const transcribe = mock(async () => ({ text: "transcribed voice" }));
		const sttProvider: SttProvider = { transcribe };
		const prompts: string[] = [];
		const rpcClient = {
			prompt: async (message: string) => {
				prompts.push(message);
			},
		} as unknown as RpcClient;

		using _hook = hookFetch(input => {
			if (String(input).includes("voice.ogg")) {
				return new Response(Buffer.from("voice-bytes"), {
					status: 200,
					headers: { "content-type": "audio/ogg" },
				});
			}
			return new Response("missing", { status: 404 });
		});

		const result = await handleTelegramMessage(ctx as unknown as AuthContext, rpcClient, {
			sttProvider,
			voiceConfig: createVoiceConfig(),
		});

		expect(result).toEqual({ isVoice: true, transcription: "transcribed voice" });
		expect(transcribe).toHaveBeenCalledTimes(1);
		expect(prompts).toEqual(["Voice transcription:\ntranscribed voice"]);
		expect(ctx._replies).toEqual([]);
	});

	it("extracts audio before transcribing video notes", async () => {
		const { handleTelegramMessage } = await loadBridgeModule();
		const ctx = createMockCtx({
			video_note: { file_id: "video-1" },
			fileMap: { "video-1": "video.mp4" },
		});
		const transcribe = mock(async () => ({ text: "video transcription" }));
		const sttProvider: SttProvider = { transcribe };
		const prompts: string[] = [];
		const rpcClient = {
			prompt: async (message: string) => {
				prompts.push(message);
			},
		} as unknown as RpcClient;

		using _hook = hookFetch(input => {
			if (String(input).includes("video.mp4")) {
				return new Response(Buffer.from("video-bytes"), {
					status: 200,
					headers: { "content-type": "video/mp4" },
				});
			}
			return new Response("missing", { status: 404 });
		});

		await handleTelegramMessage(ctx as unknown as AuthContext, rpcClient, {
			sttProvider,
			voiceConfig: createVoiceConfig(),
		});

		expect(extractAudioFromVideo).toHaveBeenCalledTimes(1);
		expect(extractAudioFromVideo).toHaveBeenCalledWith(Buffer.from("video-bytes"));
		expect(transcribe).toHaveBeenCalledWith(Buffer.from("ogg:video-bytes"), {
			mimeType: "audio/ogg",
			language: "en",
		});
		expect(prompts).toEqual(["Voice transcription:\nvideo transcription"]);
	});

	it("transcribes audio documents and appends captions", async () => {
		const { handleTelegramMessage } = await loadBridgeModule();
		const ctx = createMockCtx({
			caption: "Please summarize",
			document: { file_id: "audio-doc", file_name: "meeting.mp3", mime_type: "audio/mpeg" },
			fileMap: { "audio-doc": "meeting.mp3" },
		});
		const transcribe = mock(async () => ({ text: "document transcription" }));
		const sttProvider: SttProvider = { transcribe };
		const prompts: string[] = [];
		const rpcClient = {
			prompt: async (message: string) => {
				prompts.push(message);
			},
		} as unknown as RpcClient;

		using _hook = hookFetch(input => {
			if (String(input).includes("meeting.mp3")) {
				return new Response(Buffer.from("mp3-bytes"), {
					status: 200,
					headers: { "content-type": "audio/mpeg" },
				});
			}
			return new Response("missing", { status: 404 });
		});

		await handleTelegramMessage(ctx as unknown as AuthContext, rpcClient, {
			sttProvider,
			voiceConfig: createVoiceConfig(),
		});

		expect(transcribe).toHaveBeenCalledTimes(1);
		expect(prompts).toEqual(["Voice transcription:\ndocument transcription\n\nPlease summarize"]);
	});

	it("replies with a friendly error when STT is not configured", async () => {
		const { handleTelegramMessage, MISSING_STT_MESSAGE } = await loadBridgeModule();
		const ctx = createMockCtx({
			voice: { file_id: "voice-2", mime_type: "audio/ogg" },
		});
		const rpcClient = {
			prompt: async () => {
				throw new Error("RPC should not be called");
			},
		} as unknown as RpcClient;

		const result = await handleTelegramMessage(ctx as unknown as AuthContext, rpcClient, {});

		expect(result).toEqual({ isVoice: true });
		expect(ctx._replies).toEqual([MISSING_STT_MESSAGE]);
	});

	it("keeps empty transcriptions and caption text in the prompt", async () => {
		const { handleTelegramMessage } = await loadBridgeModule();
		const ctx = createMockCtx({
			caption: "Caption survives",
			audio: { file_id: "audio-1", mime_type: "audio/mpeg" },
			fileMap: { "audio-1": "audio.mp3" },
		});
		const transcribe = mock(async () => ({ text: "" }));
		const sttProvider: SttProvider = { transcribe };
		const prompts: string[] = [];
		const rpcClient = {
			prompt: async (message: string) => {
				prompts.push(message);
			},
		} as unknown as RpcClient;

		using _hook = hookFetch(input => {
			if (String(input).includes("audio.mp3")) {
				return new Response(Buffer.from("audio-bytes"), {
					status: 200,
					headers: { "content-type": "audio/mpeg" },
				});
			}
			return new Response("missing", { status: 404 });
		});

		const result = await handleTelegramMessage(ctx as unknown as AuthContext, rpcClient, {
			sttProvider,
			voiceConfig: createVoiceConfig(),
		});

		expect(result).toEqual({ isVoice: true, transcription: "" });
		expect(prompts).toEqual(["Voice transcription:\n\n\nCaption survives"]);
	});
});

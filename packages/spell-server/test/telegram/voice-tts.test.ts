import { describe, expect, it, mock, vi } from "bun:test";
import { hookFetch, logger } from "@spell/pi-utils";
import { createTtsProvider } from "../../src/telegram/voice";
import { DeepgramTtsProvider } from "../../src/telegram/voice/providers/deepgram-tts";
import { ElevenLabsTtsProvider } from "../../src/telegram/voice/providers/elevenlabs-tts";

describe("telegram TTS providers", () => {
	it("sends ElevenLabs request with resolved voice and returns audio bytes", async () => {
		const audioBytes = new Uint8Array([1, 2, 3, 4]);
		const fetchSpy = mock(async (input: string | Request | URL, init?: RequestInit) => {
			const request = new Request(input as string, init);
			expect(request.method).toBe("POST");
			expect(request.headers.get("xi-api-key")).toBe("eleven-key");
			expect(request.headers.get("Content-Type")).toBe("application/json");
			expect(request.headers.get("Accept")).toBe("audio/mpeg");

			const url = new URL(request.url);
			expect(url.origin + url.pathname).toBe("https://api.elevenlabs.io/v1/text-to-speech/bella");
			expect(url.searchParams.get("output_format")).toBe("opus_48000");
			expect(await request.json()).toEqual({
				text: "Hello from Telegram",
				model_id: "eleven_flash_v2_5",
			});

			return new Response(audioBytes, { status: 200, headers: { "Content-Type": "audio/ogg" } });
		});
		using _hook = hookFetch(fetchSpy);

		const provider = new ElevenLabsTtsProvider({
			provider: "elevenlabs",
			apiKey: "eleven-key", // pragma: allowlist secret
			model: "eleven_flash_v2_5",
			voice: "bella",
		});

		await expect(provider.synthesize("Hello from Telegram")).resolves.toEqual({
			audio: Buffer.from(audioBytes),
			mimeType: "audio/ogg",
		});
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("sends Deepgram Aura request and returns audio bytes", async () => {
		const audioBytes = new Uint8Array([9, 8, 7]);
		const fetchSpy = mock(async (input: string | Request | URL, init?: RequestInit) => {
			const request = new Request(input as string, init);
			expect(request.method).toBe("POST");
			expect(request.headers.get("Authorization")).toBe("Token deepgram-key");
			expect(request.headers.get("Content-Type")).toBe("application/json");

			const url = new URL(request.url);
			expect(url.origin + url.pathname).toBe("https://api.deepgram.com/v1/speak");
			expect(url.searchParams.get("model")).toBe("aura-2-thalia-en");
			expect(url.searchParams.get("encoding")).toBe("opus");
			expect(url.searchParams.get("container")).toBe("ogg");
			expect(await request.json()).toEqual({ text: "Speak now" });

			return new Response(audioBytes, { status: 200, headers: { "Content-Type": "audio/ogg" } });
		});
		using _hook = hookFetch(fetchSpy);

		const provider = new DeepgramTtsProvider({
			provider: "deepgram",
			apiKey: "deepgram-key", // pragma: allowlist secret
			model: "aura-2-thalia-en",
		});

		await expect(provider.synthesize("Speak now")).resolves.toEqual({
			audio: Buffer.from(audioBytes),
			mimeType: "audio/ogg",
		});
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("prefers per-call ElevenLabs voice override over config voice", async () => {
		const fetchSpy = mock(async (input: string | Request | URL, init?: RequestInit) => {
			const request = new Request(input as string, init);
			expect(request.url).toContain("/text-to-speech/custom-voice?");
			return new Response(new Uint8Array([1]), { status: 200 });
		});
		using _hook = hookFetch(fetchSpy);

		const provider = new ElevenLabsTtsProvider({
			provider: "elevenlabs",
			apiKey: "eleven-key", // pragma: allowlist secret
			voice: "config-voice",
		});

		await provider.synthesize("override me", { voice: "custom-voice" });
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("truncates provider input text at the configured limits with ellipsis", async () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const fetchSpy = mock(async (input: string | Request | URL, init?: RequestInit) => {
			const request = new Request(input as string, init);
			const body = (await request.json()) as { text: string };
			if (request.url.includes("elevenlabs")) {
				expect(body.text).toBe(`${"e".repeat(4_997)}...`);
			} else {
				expect(body.text).toBe(`${"d".repeat(1_997)}...`);
			}
			return new Response(new Uint8Array([1]), { status: 200 });
		});
		using _hook = hookFetch(fetchSpy);

		const elevenLabs = new ElevenLabsTtsProvider({
			provider: "elevenlabs",
			apiKey: "eleven-key", // pragma: allowlist secret
		});
		const deepgram = new DeepgramTtsProvider({
			provider: "deepgram",
			apiKey: "deepgram-key", // pragma: allowlist secret
		});

		await elevenLabs.synthesize("e".repeat(5_100));
		await deepgram.synthesize("d".repeat(2_100));

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(warnSpy).toHaveBeenCalledTimes(2);
	});

	it("surfaces descriptive HTTP errors", async () => {
		using _hook = hookFetch(input => {
			if (String(input).includes("elevenlabs")) {
				return new Response("forbidden", { status: 403, statusText: "Forbidden" });
			}
			return new Response("blocked", { status: 403, statusText: "Forbidden" });
		});

		const elevenLabs = new ElevenLabsTtsProvider({
			provider: "elevenlabs",
			apiKey: "eleven-key", // pragma: allowlist secret
		});
		const deepgram = new DeepgramTtsProvider({
			provider: "deepgram",
			apiKey: "deepgram-key", // pragma: allowlist secret
		});

		await expect(elevenLabs.synthesize("hello")).rejects.toThrow(
			"ElevenLabs TTS request failed with status 403 Forbidden: forbidden",
		);
		await expect(deepgram.synthesize("hello")).rejects.toThrow(
			"Deepgram TTS request failed with status 403 Forbidden: blocked",
		);
	});

	it("rejects empty text before issuing provider requests", async () => {
		const fetchSpy = mock(async () => new Response(new Uint8Array([1]), { status: 200 }));
		using _hook = hookFetch(fetchSpy);

		const elevenLabs = new ElevenLabsTtsProvider({
			provider: "elevenlabs",
			apiKey: "eleven-key", // pragma: allowlist secret
		});
		const deepgram = new DeepgramTtsProvider({
			provider: "deepgram",
			apiKey: "deepgram-key", // pragma: allowlist secret
		});

		await expect(elevenLabs.synthesize("")).rejects.toThrow("ElevenLabs TTS requires non-empty text");
		await expect(deepgram.synthesize("")).rejects.toThrow("Deepgram TTS requires non-empty text");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("factory returns the configured TTS provider implementation", () => {
		expect(
			createTtsProvider({
				provider: "elevenlabs",
				apiKey: "eleven-key", // pragma: allowlist secret
			}),
		).toBeInstanceOf(ElevenLabsTtsProvider);
		expect(
			createTtsProvider({
				provider: "deepgram",
				apiKey: "deepgram-key", // pragma: allowlist secret
			}),
		).toBeInstanceOf(DeepgramTtsProvider);
	});
});

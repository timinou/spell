import { describe, expect, it, mock } from "bun:test";
import { hookFetch } from "@spell/pi-utils";
import { createSttProvider } from "../../src/telegram/voice";
import { DeepgramSttProvider } from "../../src/telegram/voice/providers/deepgram-stt";
import { OpenAiSttProvider } from "../../src/telegram/voice/providers/openai-stt";

describe("telegram STT providers", () => {
	it("sends Deepgram raw audio bytes and parses the transcript response", async () => {
		const audio = Buffer.from([1, 2, 3, 4]);
		const fetchSpy = mock(async (input: string | Request | URL, init?: RequestInit) => {
			const request = new Request(input as string, init);
			const body = new Uint8Array(await request.arrayBuffer());
			expect(request.method).toBe("POST");
			expect(request.headers.get("Authorization")).toBe("Token deepgram-key");
			expect(request.headers.get("Content-Type")).toBe("audio/ogg");
			expect(Array.from(body)).toEqual(Array.from(audio));

			const url = new URL(request.url);
			expect(url.origin + url.pathname).toBe("https://api.deepgram.com/v1/listen");
			expect(url.searchParams.get("model")).toBe("nova-2-medical");
			expect(url.searchParams.get("language")).toBe("fr");
			expect(url.searchParams.get("smart_format")).toBe("true");
			expect(url.searchParams.get("punctuate")).toBe("true");

			return new Response(
				JSON.stringify({
					results: {
						channels: [{ alternatives: [{ transcript: "bonjour", confidence: 0.91 }] }],
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		using _hook = hookFetch(fetchSpy);

		const provider = new DeepgramSttProvider({
			provider: "deepgram",
			apiKey: "deepgram-key", // pragma: allowlist secret
			model: "nova-2-medical",
			language: "en",
		});

		await expect(provider.transcribe(audio, { mimeType: "audio/ogg", language: "fr" })).resolves.toEqual({
			text: "bonjour",
			confidence: 0.91,
			language: "fr",
		});
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("sends OpenAI multipart form data and parses the transcription response", async () => {
		const audio = Buffer.from([5, 6, 7, 8]);
		const fetchSpy = mock(async (input: string | Request | URL, init?: RequestInit) => {
			const request = new Request(input as string, init);
			expect(request.method).toBe("POST");
			expect(request.url).toBe("https://api.openai.com/v1/audio/transcriptions");
			expect(request.headers.get("Authorization")).toBe("Bearer openai-key");
			expect(request.headers.get("Content-Type")).toContain("multipart/form-data");

			const formData = await request.formData();
			expect(formData.get("model")).toBe("gpt-4o-mini-transcribe");
			expect(formData.get("language")).toBe("es");
			expect(formData.get("response_format")).toBe("json");

			const file = formData.get("file");
			expect(file).toBeInstanceOf(File);
			const bytes = new Uint8Array(await (file as File).arrayBuffer());
			expect(Array.from(bytes)).toEqual(Array.from(audio));

			return new Response(JSON.stringify({ text: "hola" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		using _hook = hookFetch(fetchSpy);

		const provider = new OpenAiSttProvider({
			provider: "openai",
			apiKey: "openai-key", // pragma: allowlist secret
			model: "gpt-4o-mini-transcribe",
			language: "en",
		});

		await expect(provider.transcribe(audio, { mimeType: "audio/mpeg", language: "es" })).resolves.toEqual({
			text: "hola",
			language: "es",
		});
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("surfaces Deepgram HTTP failures with provider context", async () => {
		using _hook = hookFetch(() => new Response("unauthorized", { status: 401 }));
		const provider = new DeepgramSttProvider({
			provider: "deepgram",
			apiKey: "bad-key", // pragma: allowlist secret
			language: "en",
		});

		await expect(provider.transcribe(Buffer.from([1]), { mimeType: "audio/wav" })).rejects.toThrow(
			"Deepgram STT request failed with status 401",
		);
	});

	it("surfaces OpenAI HTTP failures with provider context", async () => {
		using _hook = hookFetch(() => new Response("server error", { status: 500 }));
		const provider = new OpenAiSttProvider({
			provider: "openai",
			apiKey: "bad-key", // pragma: allowlist secret
			language: "en",
		});

		await expect(provider.transcribe(Buffer.from([1]), { mimeType: "audio/wav" })).rejects.toThrow(
			"OpenAI STT request failed with status 500",
		);
	});

	it("factory returns the configured provider implementation", () => {
		expect(
			createSttProvider({
				provider: "deepgram",
				apiKey: "deepgram-key", // pragma: allowlist secret
				language: "en",
			}),
		).toBeInstanceOf(DeepgramSttProvider);
		expect(
			createSttProvider({
				provider: "openai",
				apiKey: "openai-key", // pragma: allowlist secret
				language: "en",
			}),
		).toBeInstanceOf(OpenAiSttProvider);
	});

	it("returns empty transcriptions as empty text instead of throwing", async () => {
		using _hook = hookFetch(
			() =>
				new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: "" }] }] } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const provider = new DeepgramSttProvider({
			provider: "deepgram",
			apiKey: "deepgram-key", // pragma: allowlist secret
			language: "en",
		});

		await expect(provider.transcribe(Buffer.from([9]), { mimeType: "audio/wav" })).resolves.toEqual({
			text: "",
			confidence: undefined,
			language: "en",
		});
	});
});

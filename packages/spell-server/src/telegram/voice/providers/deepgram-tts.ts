import { logger } from "@oh-my-pi/pi-utils";
import type { TtsConfig } from "../../../config/types";
import type { TtsProvider, TtsResult } from "../tts";
import { truncateForTts } from "../tts-utils";

const DEEPGRAM_TEXT_LIMIT = 2_000;
const DEEPGRAM_DEFAULT_MODEL = "aura-asteria-en";
const PROVIDER_TIMEOUT_MS = 30_000;

export class DeepgramTtsProvider implements TtsProvider {
	#config: TtsConfig;

	constructor(config: TtsConfig) {
		this.#config = config;
	}

	async synthesize(text: string, options?: { voice?: string }): Promise<TtsResult> {
		if (text.length === 0) {
			throw new Error("Deepgram TTS requires non-empty text");
		}

		if (options?.voice) {
			logger.warn("Deepgram Aura uses model-level voices; per-request voice override is not supported", {
				requestedVoice: options.voice,
				model: this.#config.model ?? DEEPGRAM_DEFAULT_MODEL,
			});
		}

		const url = new URL("https://api.deepgram.com/v1/speak");
		url.searchParams.set("model", this.#config.model ?? DEEPGRAM_DEFAULT_MODEL);
		url.searchParams.set("encoding", "opus");
		url.searchParams.set("container", "ogg");

		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Token ${this.#config.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ text: truncateForTts(text, DEEPGRAM_TEXT_LIMIT, "Deepgram") }),
			signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
		});

		if (!response.ok) {
			const responseText = await response.text();
			throw new Error(
				`Deepgram TTS request failed with status ${response.status}${response.statusText ? ` ${response.statusText}` : ""}: ${responseText}`,
			);
		}

		return {
			audio: Buffer.from(await response.arrayBuffer()),
			mimeType: "audio/ogg",
		};
	}
}

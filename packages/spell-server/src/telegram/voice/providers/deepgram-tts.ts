import { logger } from "@oh-my-pi/pi-utils";
import type { TtsConfig } from "../../../config/types";
import type { TtsProvider, TtsResult } from "../tts";

const DEEPGRAM_TEXT_LIMIT = 2_000;
const DEEPGRAM_DEFAULT_MODEL = "aura-asteria-en";

function truncateText(text: string): string {
	if (text.length <= DEEPGRAM_TEXT_LIMIT) {
		return text;
	}

	logger.warn("Truncating Deepgram TTS input text to provider limit", {
		originalLength: text.length,
		truncatedLength: DEEPGRAM_TEXT_LIMIT,
	});
	return `${text.slice(0, DEEPGRAM_TEXT_LIMIT - 3)}...`;
}

export class DeepgramTtsProvider implements TtsProvider {
	#config: TtsConfig;

	constructor(config: TtsConfig) {
		this.#config = config;
	}

	async synthesize(text: string): Promise<TtsResult> {
		if (text.length === 0) {
			throw new Error("Deepgram TTS requires non-empty text");
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
			body: JSON.stringify({ text: truncateText(text) }),
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

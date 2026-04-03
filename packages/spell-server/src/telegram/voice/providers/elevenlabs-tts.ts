import type { TtsConfig } from "../../../config/types";
import type { TtsProvider, TtsResult } from "../tts";
import { truncateForTts } from "../tts-utils";

const ELEVENLABS_TEXT_LIMIT = 5_000;
const ELEVENLABS_DEFAULT_MODEL = "eleven_multilingual_v2";
const ELEVENLABS_DEFAULT_VOICE = "rachel";
const PROVIDER_TIMEOUT_MS = 30_000;

export class ElevenLabsTtsProvider implements TtsProvider {
	#config: TtsConfig;

	constructor(config: TtsConfig) {
		this.#config = config;
	}

	async synthesize(text: string, options?: { voice?: string }): Promise<TtsResult> {
		if (text.length === 0) {
			throw new Error("ElevenLabs TTS requires non-empty text");
		}

		const voiceId = options?.voice ?? this.#config.voice ?? ELEVENLABS_DEFAULT_VOICE;
		const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`);
		url.searchParams.set("output_format", "opus_48000");

		const response = await fetch(url, {
			method: "POST",
			headers: {
				"xi-api-key": this.#config.apiKey,
				"Content-Type": "application/json",
				Accept: "audio/mpeg",
			},
			body: JSON.stringify({
				text: truncateForTts(text, ELEVENLABS_TEXT_LIMIT, "ElevenLabs"),
				model_id: this.#config.model ?? ELEVENLABS_DEFAULT_MODEL,
			}),
			signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
		});

		if (!response.ok) {
			const responseText = await response.text();
			throw new Error(
				`ElevenLabs TTS request failed with status ${response.status}${response.statusText ? ` ${response.statusText}` : ""}: ${responseText}`,
			);
		}

		return {
			audio: Buffer.from(await response.arrayBuffer()),
			mimeType: "audio/ogg",
		};
	}
}

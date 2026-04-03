import type { TtsConfig } from "../../config/types";
import { DeepgramTtsProvider } from "./providers/deepgram-tts";
import { ElevenLabsTtsProvider } from "./providers/elevenlabs-tts";

export interface TtsResult {
	audio: Buffer;
	mimeType: string;
	duration?: number;
}

export interface TtsProvider {
	synthesize(text: string, options?: { voice?: string }): Promise<TtsResult>;
}

export function createTtsProvider(config: TtsConfig): TtsProvider {
	switch (config.provider) {
		case "elevenlabs":
			return new ElevenLabsTtsProvider(config);
		case "deepgram":
			return new DeepgramTtsProvider(config);
		default:
			throw new Error(`Unknown TTS provider: ${config.provider satisfies never}`);
	}
}

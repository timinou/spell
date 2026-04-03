import type { SttConfig } from "../../config/types";
import { DeepgramSttProvider } from "./providers/deepgram-stt";
import { OpenAiSttProvider } from "./providers/openai-stt";

export interface SttResult {
	text: string;
	confidence?: number;
	language?: string;
}

export interface SttProvider {
	transcribe(
		audio: Buffer,
		options: {
			mimeType: string;
			language?: string;
		},
	): Promise<SttResult>;
}

export function createSttProvider(config: SttConfig): SttProvider {
	switch (config.provider) {
		case "deepgram":
			return new DeepgramSttProvider(config);
		case "openai":
			return new OpenAiSttProvider(config);
		default:
			throw new Error(`Unknown STT provider: ${config.provider satisfies never}`);
	}
}

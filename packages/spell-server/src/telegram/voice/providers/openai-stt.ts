import type { SttConfig } from "../../../config/types";
import type { SttProvider, SttResult } from "../stt";

interface OpenAiTranscriptionResponse {
	text?: string;
}

const PROVIDER_TIMEOUT_MS = 30_000;

export class OpenAiSttProvider implements SttProvider {
	#config: SttConfig;

	constructor(config: SttConfig) {
		this.#config = config;
	}

	async transcribe(audio: Buffer, options: { mimeType: string; language?: string }): Promise<SttResult> {
		const formData = new FormData();
		formData.set("file", new Blob([audio], { type: options.mimeType }), "audio");
		formData.set("model", this.#config.model ?? "whisper-1");
		formData.set("language", options.language ?? this.#config.language);
		formData.set("response_format", "json");

		const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.#config.apiKey}`,
			},
			body: formData,
			signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
		});

		if (!response.ok) {
			throw new Error(`OpenAI STT request failed with status ${response.status}`);
		}

		const data = (await response.json()) as OpenAiTranscriptionResponse;
		return {
			text: data.text ?? "",
			language: options.language ?? this.#config.language,
		};
	}
}

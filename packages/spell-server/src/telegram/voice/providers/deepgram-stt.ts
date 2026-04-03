import type { SttConfig } from "../../../config/types";
import type { SttProvider, SttResult } from "../stt";

interface DeepgramAlternative {
	transcript?: string;
	confidence?: number;
}

interface DeepgramChannel {
	alternatives?: DeepgramAlternative[];
}

interface DeepgramResponse {
	results?: {
		channels?: DeepgramChannel[];
	};
}

const PROVIDER_TIMEOUT_MS = 30_000;

export class DeepgramSttProvider implements SttProvider {
	#config: SttConfig;

	constructor(config: SttConfig) {
		this.#config = config;
	}

	async transcribe(audio: Buffer, options: { mimeType: string; language?: string }): Promise<SttResult> {
		const url = new URL("https://api.deepgram.com/v1/listen");
		url.searchParams.set("model", this.#config.model ?? "nova-2");
		url.searchParams.set("language", options.language ?? this.#config.language);
		url.searchParams.set("smart_format", "true");
		url.searchParams.set("punctuate", "true");

		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Token ${this.#config.apiKey}`,
				"Content-Type": options.mimeType,
			},
			body: audio,
			signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
		});

		if (!response.ok) {
			throw new Error(`Deepgram STT request failed with status ${response.status}`);
		}

		const data = (await response.json()) as DeepgramResponse;
		const alternative = data.results?.channels?.[0]?.alternatives?.[0];
		return {
			text: alternative?.transcript ?? "",
			confidence: alternative?.confidence,
			language: options.language ?? this.#config.language,
		};
	}
}

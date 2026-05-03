/**
 * Inception Labs login flow.
 *
 * Inception provides OpenAI-compatible models via https://api.inceptionlabs.ai/v1.
 *
 * This is not OAuth - it's a simple API key flow:
 * 1. Open browser to Inception API key settings
 * 2. User copies their API key
 * 3. User pastes the API key into the CLI
 */

import { validateOpenAICompatibleApiKey } from "./api-key-validation";
import type { OAuthController } from "./types";

const AUTH_URL = "https://console.inceptionlabs.ai/api-keys";
const API_BASE_URL = "https://api.inceptionlabs.ai/v1";
const VALIDATION_MODEL = "mercury-2";

/**
 * Login to Inception Labs.
 *
 * Opens browser to API keys page, prompts user to paste their API key.
 * Returns the API key directly (not OAuthCredentials - this isn't OAuth).
 */
export async function loginInception(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new Error("Inception login requires onPrompt callback");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Copy your API key from the Inception Labs dashboard",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your Inception API key",
		placeholder: "inception-...",
	});

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const trimmed = apiKey.trim();
	if (!trimmed) {
		throw new Error("API key is required");
	}

	options.onProgress?.("Validating API key...");
	await validateOpenAICompatibleApiKey({
		provider: "Inception",
		apiKey: trimmed,
		baseUrl: API_BASE_URL,
		model: VALIDATION_MODEL,
		signal: options.signal,
	});

	return trimmed;
}

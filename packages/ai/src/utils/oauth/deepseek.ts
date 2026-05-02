/**
 * DeepSeek login flow.
 *
 * DeepSeek provides OpenAI-compatible models via https://api.deepseek.com/v1.
 *
 * This is not OAuth - it's a simple API key flow:
 * 1. Open browser to DeepSeek API key settings
 * 2. User copies their API key
 * 3. User pastes the API key into the CLI
 */

import { validateOpenAICompatibleApiKey } from "./api-key-validation";
import type { OAuthController } from "./types";

const AUTH_URL = "https://platform.deepseek.com/api_keys";
const API_BASE_URL = "https://api.deepseek.com/v1";
const VALIDATION_MODEL = "deepseek-v4-flash";

/**
 * Login to DeepSeek.
 *
 * Opens browser to API keys page, prompts user to paste their API key.
 * Returns the API key directly (not OAuthCredentials - this isn't OAuth).
 */
export async function loginDeepseek(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new Error("DeepSeek login requires onPrompt callback");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Copy your API key from the DeepSeek dashboard",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your DeepSeek API key",
		placeholder: "sk-...",
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
		provider: "DeepSeek",
		apiKey: trimmed,
		baseUrl: API_BASE_URL,
		model: VALIDATION_MODEL,
		signal: options.signal,
	});

	return trimmed;
}

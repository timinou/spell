/**
 * Kimi (API Key) login flow.
 *
 * Provides a non-OAuth alternative to the kimi-code device flow. The user
 * pastes a long-lived Kimi API key sourced from the Moonshot platform
 * console; the key is validated against the Kimi coding endpoint and
 * persisted as an api_key credential under the kimi-code provider so the
 * existing kimi-code model resolution picks it up automatically.
 */

import { validateOpenAICompatibleApiKey } from "./api-key-validation";
import type { OAuthController } from "./types";

const AUTH_URL = "https://platform.moonshot.ai/console/api-keys";
const API_BASE_URL = "https://api.kimi.com/coding/v1";
const VALIDATION_MODEL = "kimi-k2.5";

/**
 * Login to Kimi (kimi-code provider) with a static API key.
 *
 * Opens a browser tab to the Moonshot console API key page, prompts the
 * user to paste their API key, validates it, and returns the trimmed key.
 */
export async function loginKimiApiKey(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new Error("Kimi API key login requires onPrompt callback");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Copy a Kimi API key from the Moonshot console (works against api.kimi.com/coding)",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your Kimi API key",
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
		provider: "Kimi",
		apiKey: trimmed,
		baseUrl: API_BASE_URL,
		model: VALIDATION_MODEL,
		signal: options.signal,
	});

	return trimmed;
}

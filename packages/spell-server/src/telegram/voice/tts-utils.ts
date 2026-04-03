import { logger } from "@oh-my-pi/pi-utils";

/**
 * Truncate text to a provider's input limit, appending "..." when truncated.
 * Shared across TTS providers to avoid duplicating the same pattern.
 */
export function truncateForTts(text: string, limit: number, providerName: string): string {
	if (text.length <= limit) {
		return text;
	}

	logger.warn(`Truncating ${providerName} TTS input text to provider limit`, {
		originalLength: text.length,
		truncatedLength: limit,
	});
	return `${text.slice(0, limit - 3)}...`;
}

export type TelegramSendKind = 'message' | 'document' | 'photo' | 'voice';

export const TELEGRAM_CAPTION_LIMITS: Record<TelegramSendKind, number> = {
	message: 4096,
	document: 1024,
	photo: 1024,
	voice: 1024,
};

const DEFAULT_TRUNCATION_MARKER = '… (full transcript attached)';

/**
 * Trim `text` to fit Telegram's limit for `kind`, appending `truncationMarker`
 * when truncation occurred. Idempotent on already-fitting input.
 *
 * Handles Unicode properly using character boundaries (Array.from respects
 * UTF-16 surrogate pairs and other multi-unit code points).
 *
 * When marker length >= limit, the marker itself is truncated from the start
 * to fit the limit exactly.
 */
export function enforceCaptionBudget(
	text: string,
	kind: TelegramSendKind,
	truncationMarker?: string,
): string {
	const limit = TELEGRAM_CAPTION_LIMITS[kind];
	const marker = truncationMarker ?? DEFAULT_TRUNCATION_MARKER;

	// Convert to array of characters to respect Unicode boundaries
	const chars = Array.from(text);

	// Text fits within limit unchanged
	if (chars.length <= limit) {
		return text;
	}

	// Text exceeds limit, need to truncate
	// If marker is empty, just truncate to exactly fit the limit
	if (marker === '') {
		return Array.from(chars.slice(0, limit)).join('');
	}

	const markerChars = Array.from(marker);

	// If marker itself is >= limit, truncate marker from the start to fit exactly
	if (markerChars.length >= limit) {
		return markerChars.slice(markerChars.length - limit).join('');
	}

	// Truncate text + marker to fit within limit
	const availableForText = limit - markerChars.length;
	const truncatedText = chars.slice(0, availableForText).join('');
	return truncatedText + marker;
}

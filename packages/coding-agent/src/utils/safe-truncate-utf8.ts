export interface SafeTruncateUtf8Result {
	text: string;
	truncated: boolean;
}

export function safeTruncateUtf8(text: string, maxBytes: number): SafeTruncateUtf8Result {
	const cappedBytes = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : Number.MAX_SAFE_INTEGER;
	if (Buffer.byteLength(text, "utf8") <= cappedBytes) {
		return { text, truncated: false };
	}

	if (cappedBytes === 0) {
		return { text: "", truncated: text.length > 0 };
	}

	const encoded = new TextEncoder().encode(text);
	const sliced = encoded.slice(0, cappedBytes);
	let truncatedText = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(sliced);
	while (truncatedText.endsWith("\uFFFD")) {
		truncatedText = truncatedText.slice(0, -1);
	}

	return { text: truncatedText, truncated: true };
}

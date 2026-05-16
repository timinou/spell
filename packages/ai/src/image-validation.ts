import type { ImageContent, TextContent } from "./types";

export type SupportedImageMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export type ImageDropReason =
	| "empty"
	| "uri-shaped"
	| "invalid-base64"
	| "unrecognized-format"
	| "mime-mismatch"
	| "oversize";

export type ImageValidationResult =
	| { ok: true; mimeType: SupportedImageMimeType; data: string; decodedSize: number }
	| { ok: false; reason: ImageDropReason };

/** Maximum allowed decoded image size in bytes (5 MiB — Anthropic limit; OpenAI similar). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// ── Magic byte signatures (first 12 decoded bytes) ──────────────────────────
const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIG = new Uint8Array([0xff, 0xd8, 0xff]);
const GIF_SIG = new Uint8Array([0x47, 0x49, 0x46, 0x38]);
const RIFF_SIG = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
const WEBP_SIG = new Uint8Array([0x57, 0x45, 0x42, 0x50]);

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const URI_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Sniff image format from decoded bytes (first 12 bytes).
 * Returns the matching mime type or `null` if unrecognized.
 */
function sniffMime(decoded: Uint8Array): SupportedImageMimeType | null {
	if (decoded.length >= 8) {
		const head8 = decoded.slice(0, 8);
		if (head8.every((b, i) => b === PNG_SIG[i])) return "image/png";
	}
	if (decoded.length >= 3) {
		const head3 = decoded.slice(0, 3);
		if (head3.every((b, i) => b === JPEG_SIG[i])) return "image/jpeg";
	}
	if (decoded.length >= 4) {
		const head4 = decoded.slice(0, 4);
		if (head4.every((b, i) => b === GIF_SIG[i])) return "image/gif";
	}
	if (decoded.length >= 12) {
		const head4 = decoded.slice(0, 4);
		if (head4.every((b, i) => b === RIFF_SIG[i])) {
			const webp4 = decoded.slice(8, 12);
			if (webp4.every((b, i) => b === WEBP_SIG[i])) return "image/webp";
		}
	}
	return null;
}

/**
 * Validate an image content block.
 *
 * Checks (in order): empty, URI-shaped data, valid base64, recognizable format,
 * and size within `MAX_IMAGE_BYTES`.
 *
 * @returns Validation result — either `ok: true` with canonical mime type and
 * decoded size, or `ok: false` with the first failing reason.
 */
export function validateImage(block: Pick<ImageContent, "data" | "mimeType">): ImageValidationResult {
	const { data } = block;

	// 1. Empty
	if (data.length === 0) {
		return { ok: false, reason: "empty" };
	}

	// 2. URI-shaped
	if (URI_RE.test(data)) {
		return { ok: false, reason: "uri-shaped" };
	}

	// 3. Invalid base64
	if (!BASE64_RE.test(data) || data.length % 4 !== 0) {
		return { ok: false, reason: "invalid-base64" };
	}

	// Decode
	const decoded = Buffer.from(data, "base64");

	// Guard: empty buffer after decode (edge case: all-padding base64 like "==")
	if (decoded.length === 0) {
		return { ok: false, reason: "invalid-base64" };
	}

	// 4. Magic-byte sniff
	const sniffed = sniffMime(new Uint8Array(decoded));
	if (sniffed === null) {
		return { ok: false, reason: "unrecognized-format" };
	}

	// 5. Oversize (must be after sniff — we only check size for known formats)
	if (decoded.length > MAX_IMAGE_BYTES) {
		return { ok: false, reason: "oversize" };
	}

	// 6. Success — return sniffed mime (canonical; caller should use this over block.mimeType)
	return { ok: true, mimeType: sniffed, data, decodedSize: decoded.length };
}

/**
 * Build a text content block that replaces a dropped image.
 *
 * The resulting `TextContent` is safe to insert into any content array
 * consumed by the provider layer.
 */
export function buildImageDropMarker(reason: ImageDropReason, detail?: string): TextContent {
	const text = detail ? `[image dropped: ${reason}: ${detail}]` : `[image dropped: ${reason}]`;
	return { type: "text", text };
}

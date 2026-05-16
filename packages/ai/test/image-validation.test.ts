import { describe, expect, test } from "bun:test";
import { buildImageDropMarker, type ImageDropReason, MAX_IMAGE_BYTES, validateImage } from "../src/image-validation";

// ── Magic-byte fixtures (first 12 bytes of each format) ────────────────────
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const GIF_MAGIC = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
const WEBP_MAGIC = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const NOT_IMAGE = Buffer.from('{"format":"png"}', "utf-8");

// ── Helpers ─────────────────────────────────────────────────────────────────
function asBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

function oversizedImageBuffer(): Buffer {
	const prefix = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const size = MAX_IMAGE_BYTES + 1024 * 1024; // 6 MiB
	const buf = Buffer.alloc(size, 0);
	prefix.copy(buf, 0);
	return buf;
}

// ── Tests ───────────────────────────────────────────────────────────────────
describe("validateImage", () => {
	test("empty data → reason: empty", () => {
		const result = validateImage({ data: "", mimeType: "image/png" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("empty");
		}
	});

	test("artifact:// URI → reason: uri-shaped", () => {
		const result = validateImage({
			data: "artifact://blobs/code-path/x.bin",
			mimeType: "image/png",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("uri-shaped");
		}
	});

	test("file:// URI → reason: uri-shaped", () => {
		const result = validateImage({
			data: "file:///tmp/x.png",
			mimeType: "image/png",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("uri-shaped");
		}
	});

	test("http:// URI → reason: uri-shaped", () => {
		const result = validateImage({
			data: "http://x/y.png",
			mimeType: "image/png",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("uri-shaped");
		}
	});

	test("invalid base64 characters → reason: invalid-base64", () => {
		const result = validateImage({
			data: "!!!notbase64@@@",
			mimeType: "image/png",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("invalid-base64");
		}
	});

	test("base64 with whitespace → reason: invalid-base64", () => {
		const result = validateImage({
			data: "iVBORw0KGgoAAAANSUhEUgAAAAE\nAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk",
			mimeType: "image/png",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("invalid-base64");
		}
	});

	test("valid base64 but not an image → reason: unrecognized-format", () => {
		const data = asBase64(NOT_IMAGE);
		const result = validateImage({ data, mimeType: "image/png" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("unrecognized-format");
		}
	});

	test("valid base64 but wrong length (mod 4 !== 0) → reason: invalid-base64", () => {
		// "A" is valid base64 char but length % 4 === 1 → invalid
		const result = validateImage({ data: "A", mimeType: "image/png" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("invalid-base64");
		}
	});

	test("PNG magic + image/png → ok with image/png", () => {
		const data = asBase64(PNG_MAGIC);
		const result = validateImage({ data, mimeType: "image/png" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.mimeType).toBe("image/png");
			expect(result.data).toBe(data);
			expect(result.decodedSize).toBe(12);
		}
	});

	test("JPEG magic + image/png (mismatch) → ok with image/jpeg (sniffer wins)", () => {
		const data = asBase64(JPEG_MAGIC);
		const result = validateImage({ data, mimeType: "image/png" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.mimeType).toBe("image/jpeg");
			expect(result.data).toBe(data);
			expect(result.decodedSize).toBe(12);
		}
	});

	test("GIF magic → ok with image/gif", () => {
		const data = asBase64(GIF_MAGIC);
		const result = validateImage({ data, mimeType: "image/gif" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.mimeType).toBe("image/gif");
			expect(result.data).toBe(data);
		}
	});

	test("WebP magic → ok with image/webp", () => {
		const data = asBase64(WEBP_MAGIC);
		const result = validateImage({ data, mimeType: "image/webp" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.mimeType).toBe("image/webp");
			expect(result.data).toBe(data);
		}
	});

	test("oversized PNG → reason: oversize", () => {
		const data = oversizedImageBuffer().toString("base64");
		const result = validateImage({ data, mimeType: "image/png" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("oversize");
		}
	});

	test("empty check runs before URI check", () => {
		// data is empty but also looks URI-ish — empty should fire first
		const result = validateImage({ data: "", mimeType: "image/png" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("empty");
		}
	});

	test("URI check runs before base64 check", () => {
		// data is URI-shaped with chars that would pass base64 regex
		const result = validateImage({
			data: "http://example.com/image.png",
			mimeType: "image/png",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("uri-shaped");
		}
	});
});

describe("buildImageDropMarker", () => {
	test("reason only → text with reason", () => {
		const marker = buildImageDropMarker("uri-shaped");
		expect(marker).toEqual({
			type: "text",
			text: "[image dropped: uri-shaped]",
		});
	});

	test("reason + detail → text with reason and detail", () => {
		const marker = buildImageDropMarker("oversize", "6.2 MiB");
		expect(marker).toEqual({
			type: "text",
			text: "[image dropped: oversize: 6.2 MiB]",
		});
	});

	test("all drop reasons produce valid TextContent", () => {
		const reasons: ImageDropReason[] = [
			"empty",
			"uri-shaped",
			"invalid-base64",
			"unrecognized-format",
			"mime-mismatch",
			"oversize",
		];
		for (const reason of reasons) {
			const marker = buildImageDropMarker(reason);
			expect(marker.type).toBe("text");
			expect(marker.text).toContain(reason);
		}
	});
});

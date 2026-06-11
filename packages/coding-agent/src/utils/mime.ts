import * as fs from "node:fs/promises";

const FILE_TYPE_SNIFF_BYTES = 12;

function detectMimeFromBytes(buf: Buffer, bytesRead: number): string | null {
	if (bytesRead >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
		return "image/jpeg";
	}
	if (
		bytesRead >= 8 &&
		buf[0] === 0x89 &&
		buf[1] === 0x50 &&
		buf[2] === 0x4e &&
		buf[3] === 0x47 &&
		buf[4] === 0x0d &&
		buf[5] === 0x0a &&
		buf[6] === 0x1a &&
		buf[7] === 0x0a
	) {
		return "image/png";
	}
	if (bytesRead >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
		return "image/gif";
	}
	if (
		bytesRead >= 12 &&
		buf[0] === 0x52 &&
		buf[1] === 0x49 &&
		buf[2] === 0x46 &&
		buf[3] === 0x46 &&
		buf[8] === 0x57 &&
		buf[9] === 0x45 &&
		buf[10] === 0x42 &&
		buf[11] === 0x50
	) {
		return "image/webp";
	}
	return null;
}

export async function detectSupportedImageMimeTypeFromFile(filePath: string): Promise<string | null> {
	const fileHandle = await fs.open(filePath, "r");
	try {
		const buffer = Buffer.allocUnsafe(FILE_TYPE_SNIFF_BYTES);
		const { bytesRead } = await fileHandle.read(buffer, 0, FILE_TYPE_SNIFF_BYTES, 0);
		if (bytesRead === 0) {
			return null;
		}
		return detectMimeFromBytes(buffer, bytesRead);
	} finally {
		await fileHandle.close();
	}
}

/**
 * Number of leading bytes sampled to decide whether a file is binary.
 * Matches the kernel's UTF-8 sniff window (`anchors.rs` FsAnchor::Binary) so
 * the TS read path and the Rust resolver agree on text-vs-binary.
 */
const BINARY_SNIFF_BYTES = 8192;

/**
 * Heuristic binary detector: a NUL byte or an invalid-UTF-8 sequence within
 * the first {@link BINARY_SNIFF_BYTES} marks the buffer as binary. This mirrors
 * the kernel's `std::str::from_utf8` sample check (one definition, both sides).
 */
export function isBinarySample(buf: Buffer, bytesRead: number): boolean {
	const end = Math.min(bytesRead, BINARY_SNIFF_BYTES);
	if (end === 0) return false;
	const sample = buf.subarray(0, end);
	// A NUL byte is the cheapest binary signal; otherwise a strict UTF-8 decode
	// failure means the bytes aren't text.
	if (sample.includes(0)) return true;
	return !isValidUtf8(sample);
}

function isValidUtf8(sample: Buffer): boolean {
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(sample);
		return true;
	} catch {
		return false;
	}
}

/** Classification of a filesystem path for the read/`find`/`get` content path. */
export type FileReadClassification = { kind: "image"; mimeType: string } | { kind: "binary" } | { kind: "text" };

/**
 * Classify a file by content for the read path: a magic-byte image type wins
 * (→ image content block), else a binary sniff (→ artifact marker, never a
 * mojibake text dump), else plain text. Single source of truth for how `find`
 * / `get` decide what kind of content block a bare-path read produces.
 */
export async function classifyFileForRead(filePath: string): Promise<FileReadClassification> {
	const fileHandle = await fs.open(filePath, "r");
	try {
		const buffer = Buffer.allocUnsafe(BINARY_SNIFF_BYTES);
		const { bytesRead } = await fileHandle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
		if (bytesRead === 0) return { kind: "text" };
		const mimeType = detectMimeFromBytes(buffer, bytesRead);
		if (mimeType) return { kind: "image", mimeType };
		if (isBinarySample(buffer, bytesRead)) return { kind: "binary" };
		return { kind: "text" };
	} finally {
		await fileHandle.close();
	}
}

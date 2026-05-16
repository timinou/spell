import { describe, expect, it } from "bun:test";
import { truncateForPersistence } from "@oh-my-pi/pi-coding-agent/session/session-manager";

/**
 * Minimal BlobStore stub — returns a deterministic blob:sha256: ref for any input.
 * Does not actually persist data; sufficient for testing the guard logic.
 */
function stubBlobStore(): any {
	return {
		put: async (data: string) => ({ ref: `blob:sha256:${Buffer.from(data).toString("hex").slice(0, 16)}` }),
	};
}

// A PNG large enough to trigger the BLOB_EXTERNALIZE_THRESHOLD (1024).
const LARGE_VALID_PNG = (() => {
	const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	return Buffer.from([...header, ...new Array(2048).fill(0)]).toString("base64");
})();

// A valid JPEG as base64 (just the SOI marker).
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00]).toString("base64");

describe("truncateForPersistence — image guard", () => {
	it("URI-shaped data is substituted with text marker", async () => {
		const input = {
			content: [{ type: "image", data: "artifact://blobs/code-path/x.bin", mimeType: "image/png" }],
		};
		const out: any = await truncateForPersistence(input, stubBlobStore(), null);
		expect(out.content).toHaveLength(1);
		expect(out.content[0].type).toBe("text");
		expect(out.content[0].text).toContain("[image dropped at persist: uri-shaped]");
	});

	it("empty base64 → text marker", async () => {
		const input = { content: [{ type: "image", data: "", mimeType: "image/png" }] };
		const out: any = await truncateForPersistence(input, stubBlobStore(), null);
		expect(out.content[0].type).toBe("text");
		expect(out.content[0].text).toContain("empty");
	});

	it("garbage base64 → text marker", async () => {
		const input = { content: [{ type: "image", data: "!!!notbase64", mimeType: "image/png" }] };
		const out: any = await truncateForPersistence(input, stubBlobStore(), null);
		expect(out.content[0].type).toBe("text");
	});

	it("valid large PNG is externalized to blob:sha256: (regression guard)", async () => {
		const input = { content: [{ type: "image", data: LARGE_VALID_PNG, mimeType: "image/png" }] };
		const out: any = await truncateForPersistence(input, stubBlobStore(), null);
		expect(out.content[0].type).toBe("image");
		expect(out.content[0].data).toStartWith("blob:sha256:");
	});

	it("existing blob ref passes through unchanged", async () => {
		const input = { content: [{ type: "image", data: "blob:sha256:abc123", mimeType: "image/png" }] };
		const out: any = await truncateForPersistence(input, stubBlobStore(), null);
		expect(out.content[0].type).toBe("image");
		expect(out.content[0].data).toBe("blob:sha256:abc123");
	});

	it("mime correction: JPEG bytes declared as PNG → mime corrected, image preserved", async () => {
		const input = { content: [{ type: "image", data: JPEG_B64, mimeType: "image/png" }] };
		const out: any = await truncateForPersistence(input, stubBlobStore(), null);
		expect(out.content[0].type).toBe("image");
		expect(out.content[0].mimeType).toBe("image/jpeg");
	});
});

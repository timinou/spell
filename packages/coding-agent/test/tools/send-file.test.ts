import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { SendFileTool } from "@oh-my-pi/pi-coding-agent/tools/send-file";

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
	};
}

describe("SendFileTool", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "send-file-tool-"));
	});

	afterEach(async () => {
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("returns document delivery with PDF mime type", async () => {
		const filePath = path.join(tempDir, "report.pdf");
		await Bun.write(filePath, "pdf-data");
		const tool = new SendFileTool(makeSession(tempDir));

		const result = await tool.execute("call-1", { path: "report.pdf" });
		const delivery = result.details?.delivery;

		expect(delivery).toBeDefined();
		expect(delivery?.type).toBe("document");
		expect(delivery?.mimeType).toBe("application/pdf");
		expect(delivery?.fileName).toBe("report.pdf");
	});

	it("returns photo delivery for PNG files", async () => {
		const filePath = path.join(tempDir, "image.png");
		await Bun.write(filePath, "png-data");
		const tool = new SendFileTool(makeSession(tempDir));

		const result = await tool.execute("call-2", { path: "image.png" });

		expect(result.details?.delivery.type).toBe("photo");
		expect(result.details?.delivery.mimeType).toBe("image/png");
	});

	it("falls back to application/octet-stream for unknown extensions", async () => {
		const filePath = path.join(tempDir, "blob.xyz");
		await Bun.write(filePath, "data");
		const tool = new SendFileTool(makeSession(tempDir));

		const result = await tool.execute("call-3", { path: "blob.xyz" });

		expect(result.details?.delivery.mimeType).toBe("application/octet-stream");
		expect(result.details?.delivery.type).toBe("document");
	});

	it("errors when the file does not exist", async () => {
		const tool = new SendFileTool(makeSession(tempDir));

		await expect(tool.execute("call-4", { path: "missing.pdf" })).rejects.toThrow(/not found/i);
	});

	it("errors when the file exceeds the Telegram size limit", async () => {
		const filePath = path.join(tempDir, "big.bin");
		await Bun.write(filePath, "x");
		await fs.truncate(filePath, 51 * 1024 * 1024);
		const tool = new SendFileTool(makeSession(tempDir));

		await expect(tool.execute("call-5", { path: "big.bin" })).rejects.toThrow(/too large/i);
	});

	it("uses the filename override when provided", async () => {
		const filePath = path.join(tempDir, "report.txt");
		await Bun.write(filePath, "hello");
		const tool = new SendFileTool(makeSession(tempDir));

		const result = await tool.execute("call-6", {
			path: "report.txt",
			filename: "renamed.txt",
		});

		expect(result.details?.delivery.fileName).toBe("renamed.txt");
	});

	it("preserves caption in delivery details", async () => {
		const filePath = path.join(tempDir, "notes.txt");
		await Bun.write(filePath, "hello");
		const tool = new SendFileTool(makeSession(tempDir));

		const result = await tool.execute("call-7", {
			path: "notes.txt",
			caption: "Review this file",
		});

		expect(result.details?.delivery.caption).toBe("Review this file");
	});

	it("resolves relative paths against the session cwd", async () => {
		const nestedDir = path.join(tempDir, "nested");
		const filePath = path.join(nestedDir, "report.csv");
		await fs.mkdir(nestedDir, { recursive: true });
		await Bun.write(filePath, "a,b");
		const tool = new SendFileTool(makeSession(tempDir));

		const result = await tool.execute("call-8", { path: "nested/report.csv" });

		expect(result.details?.delivery.absolutePath).toBe(filePath);
	});

	it("includes a human-readable file size in the text output", async () => {
		const filePath = path.join(tempDir, "tiny.txt");
		await Bun.write(filePath, "abc");
		const tool = new SendFileTool(makeSession(tempDir));

		const result = await tool.execute("call-9", { path: "tiny.txt" });
		const textBlock = result.content[0];

		expect(textBlock?.type).toBe("text");
		if (textBlock?.type !== "text") {
			throw new Error("Expected text output");
		}
		expect(textBlock.text).toContain("tiny.txt");
		expect(textBlock.text).toContain("3B");
	});
});

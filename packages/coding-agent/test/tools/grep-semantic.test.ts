import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";

function getResultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(content => content.type === "text")
		.map(content => content.text ?? "")
		.join("\n");
}

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

describe("GrepTool semantic and target-aware output", () => {
	it("routes simple symbol queries through semantic lookup", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-semantic-"));
		try {
			await Bun.write(
				path.join(tmpDir, "rate.ts"),
				["export function rateLimit() {", "  return 1;", "}", ""].join("\n"),
			);
			const tool = new GrepTool(createSession(tmpDir));
			const result = await tool.execute("test-call", { pattern: "rateLimit", mode: "semantic" });
			const text = getResultText(result);
			expect(text).toContain("Semantic grep (symbols)");
			expect(text).toContain("Query: rateLimit");
			expect(text).toContain("targetId: rate.ts::rateLimit");
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("keeps explicit rawText mode on regex-style content search", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-semantic-"));
		try {
			await Bun.write(path.join(tmpDir, "rate.ts"), "export function rateLimit() { return 1; }\n");
			const tool = new GrepTool(createSession(tmpDir));
			const result = await tool.execute("test-call", { pattern: "rate.*", path: "rate.ts", mode: "rawText" });
			const text = getResultText(result);
			expect(text.startsWith(">>")).toBe(true);
			expect(text).toContain("targetId: rate.ts::rateLimit");
			expect(text).not.toContain("Semantic grep");
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("adds scopeTarget metadata for non-declaration raw-text hits", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-semantic-"));
		try {
			await Bun.write(
				path.join(tmpDir, "rate.ts"),
				["export function rateLimit() {", "  const delay = 1;", "  return delay;", "}", ""].join("\n"),
			);
			const tool = new GrepTool(createSession(tmpDir));
			const result = await tool.execute("test-call", { pattern: "delay", path: "rate.ts", mode: "rawText" });
			const text = getResultText(result);
			expect(text).toContain("scopeTarget: rateLimit");
			expect(text).toContain("scopeTargetId: rate.ts::rateLimit");
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("uses auto mode for simple repo-local symbol queries", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-semantic-"));
		try {
			await Bun.write(path.join(tmpDir, "widget.ts"), "export class Widget {}\n");
			const tool = new GrepTool(createSession(tmpDir));
			const result = await tool.execute("test-call", { pattern: "Widget" });
			const text = getResultText(result);
			expect(text).toContain("Semantic grep (symbols)");
			expect(text).toContain("targetId: widget.ts::Widget");
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});
});

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

describe("GrepTool staged output", () => {
	it("surfaces staged file-hit guidance first for broad grep", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-staging-"));
		try {
			await Bun.write(
				path.join(tmpDir, "alpha.ts"),
				["export const alpha = 1;", "export const marker = 'broad-hit';", ""].join("\n"),
			);
			await Bun.write(
				path.join(tmpDir, "beta.ts"),
				["export const beta = 2;", "export const marker = 'broad-hit';", ""].join("\n"),
			);
			await fs.mkdir(path.join(tmpDir, ".spell", "agent", "sessions"), { recursive: true });
			await Bun.write(
				path.join(tmpDir, ".spell", "agent", "sessions", "recent.jsonl"),
				['{"toolName":"grep","pattern":"broad-hit"}', '{"toolName":"grep","pattern":"broad-hit"}', ""].join("\n"),
			);

			const tool = new GrepTool(createSession(tmpDir));
			const result = await tool.execute("test-call", { pattern: "broad-hit", path: "." });
			const text = getResultText(result);

			expect(text).toContain("4 matches across 3 files.");
			expect(text).toContain("File hits:");
			expect(text).toContain("alpha.ts");
			expect(text).toContain("beta.ts");
			expect(text).toContain("recent.jsonl");
			expect(text).not.toContain(">>");
			expect((result.details as { fileCount?: number; matchCount?: number } | undefined)?.fileCount).toBe(3);
			expect((result.details as { fileCount?: number; matchCount?: number } | undefined)?.matchCount).toBe(4);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("keeps focused grep direct for explicit path and limit semantics", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-staging-"));
		try {
			await Bun.write(
				path.join(tmpDir, "focused.ts"),
				["const one = 'needle';", "const two = 'needle';", "const three = 'needle';", ""].join("\n"),
			);

			const tool = new GrepTool(createSession(tmpDir));
			const result = await tool.execute("test-call", {
				pattern: "needle",
				path: "focused.ts",
				limit: 2,
				offset: 1,
			});
			const text = getResultText(result);

			expect(text.startsWith(">>")).toBe(true);
			expect(text).toContain("targetId: focused.ts::two");
			expect(text).toContain("two");
			expect(text).toContain("three");
			expect(text).not.toContain("one");
			expect((result.details as { matchCount?: number; fileCount?: number } | undefined)?.matchCount).toBe(2);
			expect((result.details as { matchCount?: number; fileCount?: number } | undefined)?.fileCount).toBe(1);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("treats .spell transcript grep as spelunking noise", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-staging-"));
		try {
			await fs.mkdir(path.join(tmpDir, ".spell", "agent", "sessions"), { recursive: true });
			await Bun.write(
				path.join(tmpDir, ".spell", "agent", "sessions", "recent.jsonl"),
				['{"role":"toolResult","toolName":"grep"}', '{"role":"toolResult","toolName":"grep"}', ""].join("\n"),
			);

			const tool = new GrepTool(createSession(tmpDir));
			const result = await tool.execute("test-call", {
				pattern: "toolResult",
				path: ".spell/agent/sessions/recent.jsonl",
			});
			const text = getResultText(result);

			expect(text).toContain("Raw match sets suppressed as transcript spelunking.");
			expect(
				(result.details as { fileCount?: number; matchCount?: number; scopePath?: string } | undefined)?.scopePath,
			).toBe(".spell/agent/sessions/recent.jsonl");
			expect((result.details as { matchCount?: number; fileCount?: number } | undefined)?.matchCount).toBe(2);
			expect((result.details as { matchCount?: number; fileCount?: number } | undefined)?.fileCount).toBe(1);
			expect(text).not.toContain(">>");
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});
});

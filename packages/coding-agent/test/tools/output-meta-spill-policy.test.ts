import { describe, expect, it } from "bun:test";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@spell/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { Settings } from "../../src/config/settings";
import { wrapToolWithMetaNotice } from "../../src/tools/output-meta";
import { ToolError } from "../../src/tools/tool-errors";

const testSchema = Type.Object({});

type TestDetails = { meta?: { truncation?: unknown } };

function createContext(settings: Settings = Settings.isolated()) {
	const saved: Array<{ text: string; toolName: string }> = [];
	const context = {
		settings,
		sessionManager: {
			saveArtifact: async (text: string, toolName: string) => {
				saved.push({ text, toolName });
				const id = String(saved.length - 1);
				return {
					id,
					uri: `artifact://test-session/main/${toolName}/${id}.txt`,
					path: `/tmp/${toolName}-${id}.txt`,
				};
			},
		},
	} as unknown as AgentToolContext;

	return { context, saved };
}

function createWrappedTool(
	name: string,
	execute: () => Promise<AgentToolResult<TestDetails>> | AgentToolResult<TestDetails>,
): AgentTool<typeof testSchema, TestDetails> {
	const tool = {
		name,
		label: name,
		description: name,
		parameters: testSchema,
		concurrency: "parallel" as const,
		strict: true,
		execute: async () => await execute(),
	};
	return wrapToolWithMetaNotice(tool as unknown as AgentTool<typeof testSchema, TestDetails>);
}

describe("wrapToolWithMetaNotice spill policy", () => {
	it("spills non-precision tool output once line threshold is exceeded", async () => {
		const output = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n");
		const tool = createWrappedTool("fetch", () => ({ content: [{ type: "text", text: output }], data: null }));
		const { context, saved } = createContext();

		const result = await tool.execute("call-1", {}, undefined, undefined, context);
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		const truncation = result.details?.meta?.truncation;

		expect(saved).toHaveLength(1);
		expect(text).toContain("line 80");
		expect(text).toContain("line 31");
		expect(text).not.toContain("line 30");
		expect(text).toContain("artifact://test-session/main/fetch/0.txt");
		expect(truncation).toBeDefined();
	});

	it("keeps precision tools inline under the low-spill default", async () => {
		const output = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n");
		const tool = createWrappedTool("read", () => ({ content: [{ type: "text", text: output }], data: null }));
		const { context, saved } = createContext();

		const result = await tool.execute("call-2", {}, undefined, undefined, context);
		const text = result.content.find(block => block.type === "text")?.text ?? "";

		expect(saved).toHaveLength(0);
		expect(text).toContain("line 1");
		expect(text).toContain("line 80");
		expect(text).not.toContain("artifact://");
	});

	it("keeps get tool output inline up to tools.getSpillThreshold (default 25k tokens / ~100KB)", async () => {
		// 80 short lines is well below the 100KB byte cap and there is no line cap.
		const output = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n");
		const tool = createWrappedTool("get", () => ({ content: [{ type: "text", text: output }], data: null }));
		const { context, saved } = createContext();

		const result = await tool.execute("call-get-1", {}, undefined, undefined, context);
		const text = result.content.find(block => block.type === "text")?.text ?? "";

		expect(saved).toHaveLength(0);
		expect(text).toContain("line 1");
		expect(text).toContain("line 80");
		expect(text).not.toContain("artifact://");
	});

	it("spills get tool output above tools.getSpillThreshold with tail-mode equal to threshold", async () => {
		const settings = Settings.isolated();
		// 1000 tokens → 4000-byte threshold; trigger AND inline tail both = 4KB.
		settings.set("tools.getSpillThreshold", 1000);
		// Each line is 16 bytes ("line 0001\n" etc.). 600 lines ≈ 6000 bytes → above 4KB.
		const lines = Array.from({ length: 600 }, (_, index) => `line ${String(index + 1).padStart(4, "0")}`);
		const output = lines.join("\n");
		const tool = createWrappedTool("get", () => ({ content: [{ type: "text", text: output }], data: null }));
		const { context, saved } = createContext(settings);

		const result = await tool.execute("call-get-2", {}, undefined, undefined, context);
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		const truncation = result.details?.meta?.truncation;

		expect(saved).toHaveLength(1);
		expect(saved[0]?.toolName).toBe("get");
		expect(saved[0]?.text).toBe(output); // artifact stores the full payload
		expect(text).toContain("artifact://test-session/main/get/0.txt");
		expect(truncation).toBeDefined();
		// Tail-mode: last line must be present; head lines must not.
		expect(text).toContain("line 0600");
		expect(text).not.toContain("line 0001");
	});

	it("uses the larger failure inline budget for wrapped tool errors", async () => {
		const output = Array.from({ length: 140 }, (_, index) => `line ${index + 1}`).join("\n");
		const tool = createWrappedTool("fetch", () => {
			throw new ToolError(output);
		});
		const { context, saved } = createContext();

		try {
			await tool.execute("call-3", {}, undefined, undefined, context);
			throw new Error("expected wrapped tool to fail");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(saved).toHaveLength(1);
			expect(message).toContain("artifact://test-session/main/fetch/0.txt");
			expect(message).toContain("line 21");
			expect(message).toContain("line 140");
			expect(message).not.toContain("line 20");
		}
	});
});

import type { AgentTool, AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import { wrapToolWithMetaNotice } from "../../src/tools/output-meta";
import { ToolError } from "../../src/tools/tool-errors";

const testSchema = Type.Object({});

type TestDetails = { meta?: unknown };

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
		const tool = createWrappedTool("fetch", () => ({ content: [{ type: "text", text: output }] }));
		const { context, saved } = createContext();

		const result = await tool.execute("call-1", {}, undefined, undefined, context);
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		const truncation =
			result.details?.meta && "truncation" in result.details.meta ? result.details.meta.truncation : undefined;

		expect(saved).toHaveLength(1);
		expect(text).toContain("line 80");
		expect(text).toContain("line 31");
		expect(text).not.toContain("line 30");
		expect(text).toContain("artifact://test-session/main/fetch/0.txt");
		expect(truncation).toBeDefined();
	});

	it("keeps precision tools inline under the low-spill default", async () => {
		const output = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n");
		const tool = createWrappedTool("read", () => ({ content: [{ type: "text", text: output }] }));
		const { context, saved } = createContext();

		const result = await tool.execute("call-2", {}, undefined, undefined, context);
		const text = result.content.find(block => block.type === "text")?.text ?? "";

		expect(saved).toHaveLength(0);
		expect(text).toContain("line 1");
		expect(text).toContain("line 80");
		expect(text).not.toContain("artifact://");
	});

	it("uses the larger failure inline budget for wrapped tool errors", async () => {
		const output = Array.from({ length: 140 }, (_, index) => `line ${index + 1}`).join("\n");
		const tool = createWrappedTool("fetch", () => {
			throw new ToolError(output);
		});
		const { context, saved } = createContext();

		await expect(tool.execute("call-3", {}, undefined, undefined, context)).rejects.toThrow(
			expect.objectContaining({ message: expect.stringContaining("artifact://test-session/main/fetch/0.txt") }),
		);
		expect(saved).toHaveLength(1);

		try {
			await tool.execute("call-3", {}, undefined, undefined, context);
			throw new Error("expected wrapped tool to fail");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).toContain("line 21");
			expect(message).toContain("line 140");
			expect(message).not.toContain("line 20");
		}
	});
});

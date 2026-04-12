import { describe, expect, it } from "bun:test";
import type { AssistantMessage, ToolCall } from "../../src/types";
import { classifyToolCallStreamInterruption } from "../../src/utils/tool-call-diagnostics";

function makeOutput(toolCallOverrides: Partial<ToolCall> & { partialJson?: string }): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "call_1",
				name: "todo_write",
				arguments: { command: "create" },
				...toolCallOverrides,
			} as ToolCall & { partialJson?: string },
		],
		api: "cursor-agent",
		provider: "cursor",
		model: "cursor-fast",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		timestamp: Date.now(),
	};
}

describe("Cursor provider stall classification", () => {
	it("classifies incomplete tool args from cursor output", () => {
		const output = makeOutput({ partialJson: '{"command":"create"' });
		const diagnostic = classifyToolCallStreamInterruption(output);
		expect(diagnostic).toBeDefined();
		expect(diagnostic!.state).toBe("stalled_incomplete_tool_args");
		expect(diagnostic!.toolName).toBe("todo_write");
	});

	it("classifies completed tool call missing trailing stop", () => {
		const output = makeOutput({});
		const diagnostic = classifyToolCallStreamInterruption(output);
		expect(diagnostic).toBeDefined();
		expect(diagnostic!.state).toBe("completed_tool_call_missing_trailing_stop");
	});

	it("classifies stalled before any tool args when partialJson is empty", () => {
		const output = makeOutput({ partialJson: "" });
		const diagnostic = classifyToolCallStreamInterruption(output);
		expect(diagnostic).toBeDefined();
		expect(diagnostic!.state).toBe("stalled_before_tool_args");
	});
});

import { describe, expect, it } from "bun:test";
import type { AssistantMessage, ToolCall } from "../../src/types";
import {
	classifyToolCallStreamInterruption,
	hasActiveToolArgumentStreaming,
} from "../../src/utils/tool-call-diagnostics";

function makeOutput(toolCallOverrides: Partial<ToolCall> & { partialJson?: string }): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "call_1",
				name: "write",
				arguments: { path: "test.md" },
				...toolCallOverrides,
			} as ToolCall & { partialJson?: string },
		],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "codex-mini-latest",
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

describe("Codex stall classification", () => {
	it("classifies incomplete tool args from codex output", () => {
		const output = makeOutput({ partialJson: '{"path":"test.md"' });
		const diagnostic = classifyToolCallStreamInterruption(output);
		expect(diagnostic).toBeDefined();
		expect(diagnostic!.state).toBe("stalled_incomplete_tool_args");
		expect(diagnostic!.toolName).toBe("write");
		expect(diagnostic!.parsedArgumentKeys).toEqual(["path"]);
	});

	it("detects active tool argument streaming", () => {
		const output = makeOutput({ partialJson: '{"path":"test.md"' });
		expect(hasActiveToolArgumentStreaming(output)).toBe(true);
	});

	it("does not detect active tool argument streaming without partialJson", () => {
		const output = makeOutput({});
		expect(hasActiveToolArgumentStreaming(output)).toBe(false);
	});

	it("classifies completed tool call missing trailing stop", () => {
		const output = makeOutput({});
		const diagnostic = classifyToolCallStreamInterruption(output);
		expect(diagnostic).toBeDefined();
		expect(diagnostic!.state).toBe("completed_tool_call_missing_trailing_stop");
	});
});

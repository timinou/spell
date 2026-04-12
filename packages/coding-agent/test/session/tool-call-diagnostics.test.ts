import { describe, expect, it } from "bun:test";
import { type AssistantMessage, createToolCallStreamDiagnostic } from "@oh-my-pi/pi-ai";
import { formatAssistantToolCallFailureMessage } from "../../src/session/tool-call-diagnostics";

describe("formatAssistantToolCallFailureMessage", () => {
	it("prefers shared stalled-tool diagnostics and includes raw artifact references", () => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "tool_1",
					name: "write",
					arguments: { path: "specs/markdown-code-engine-integration.md" },
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "legacy provider string",
			streamDiagnostics: [
				createToolCallStreamDiagnostic({
					state: "stalled_incomplete_tool_args",
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					toolName: "write",
					toolCallId: "tool_1",
					arguments: { path: "specs/markdown-code-engine-integration.md" },
					rawPartialJsonBytes: 54,
					rawPartialJsonArtifact: { uri: "artifact://14b7be567342b8fe/main/tool-call-diagnostic/0.json" },
					idleTimeoutMs: 45_000,
					providerRetryAttempt: 2,
				}),
			],
			timestamp: 1,
		};

		const formatted = formatAssistantToolCallFailureMessage(message);

		expect(formatted).toContain("Tool call write stalled while streaming incomplete tool arguments.");
		expect(formatted).toContain("Idle timeout: 45000ms.");
		expect(formatted).toContain("Retry attempts: 2.");
		expect(formatted).toContain("artifact://14b7be567342b8fe/main/tool-call-diagnostic/0.json");
		expect(formatted).not.toContain("legacy provider string");
	});
});

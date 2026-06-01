import { describe, expect, it } from "bun:test";
import { type AssistantMessage, createToolCallStreamDiagnostic } from "@spell/pi-ai";
import {
	formatAssistantToolCallFailureMessage,
	formatRetryableAssistantErrorMessage,
	isRetryableAssistantStreamError,
} from "../../src/session/tool-call-diagnostics";

function createAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
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
		...overrides,
	};
}

describe("formatAssistantToolCallFailureMessage", () => {
	it("prefers shared stalled-tool diagnostics and includes raw artifact references", () => {
		const message = createAssistantMessage();

		const formatted = formatAssistantToolCallFailureMessage(message);

		expect(formatted).toContain("Tool call write stalled while streaming incomplete tool arguments.");
		expect(formatted).toContain("Idle timeout: 45000ms.");
		expect(formatted).toContain("Retry attempts: 2.");
		expect(formatted).toContain("artifact://14b7be567342b8fe/main/tool-call-diagnostic/0.json");
		expect(formatted).toContain("Partial arguments saved to artifact://14b7be567342b8fe/main/tool-call-diagnostic/0.json (54 bytes)");
		expect(formatted).toContain("Override timeout with PI_TOOL_ARGUMENT_STREAM_IDLE_TIMEOUT_MS=<ms>");
		expect(formatted).not.toContain("legacy provider string");
	});

	it("keeps retry attempt context when the session rewrites the failure message", () => {
		const message = createAssistantMessage({
			errorMessage:
				"Attempt 1/3 failed; retrying. Tool call write stalled while streaming incomplete tool arguments. Idle timeout: 45000ms. Retry attempts: 2.",
		});

		const formatted = formatAssistantToolCallFailureMessage(message);

		expect(formatted).toContain("Attempt 1/3 failed; retrying.");
		expect(formatted).toContain("artifact://14b7be567342b8fe/main/tool-call-diagnostic/0.json");
	});
});

describe("formatRetryableAssistantErrorMessage", () => {
	it("builds intermediate and final retry labels from stream diagnostics", () => {
		const message = createAssistantMessage({
			streamDiagnostics: [
				createToolCallStreamDiagnostic({
					state: "stalled_before_response_content",
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					rawPartialJsonBytes: 0,
					idleTimeoutMs: 10,
					providerRetryAttempt: 0,
				}),
			],
		});

		expect(formatRetryableAssistantErrorMessage(message, { attempt: 1, maxAttempts: 3, final: false })).toBe(
			"Attempt 1/3 failed; retrying. Assistant response stalled before any response content arrived. Idle timeout: 10ms.",
		);
		expect(formatRetryableAssistantErrorMessage(message, { attempt: 3, maxAttempts: 3, final: true })).toBe(
			"Final attempt 3/3 failed. Assistant response stalled before any response content arrived. Idle timeout: 10ms.",
		);
	});
});

describe("isRetryableAssistantStreamError", () => {
	it("treats non-terminal stall diagnostics as retryable but excludes completed-tool recovery", () => {
		const retryable = createAssistantMessage({
			streamDiagnostics: [
				createToolCallStreamDiagnostic({
					state: "stalled_during_text",
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					rawPartialJsonBytes: 0,
					idleTimeoutMs: 10,
					providerRetryAttempt: 0,
				}),
			],
		});
		const recovered = createAssistantMessage({
			streamDiagnostics: [
				createToolCallStreamDiagnostic({
					state: "completed_tool_call_missing_trailing_stop",
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					toolName: "write",
					toolCallId: "tool_1",
					arguments: { path: "specs/markdown-code-engine-integration.md" },
					rawPartialJsonBytes: 0,
					idleTimeoutMs: 10,
					providerRetryAttempt: 0,
				}),
			],
		});

		expect(isRetryableAssistantStreamError(retryable)).toBe(true);
		expect(isRetryableAssistantStreamError(recovered)).toBe(false);
	});
});

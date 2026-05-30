import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@spell/pi-ai/providers/anthropic";
import type { AssistantMessage, Model, UserMessage } from "@spell/pi-ai/types";

const model: Model<"anthropic-messages"> = {
	api: "anthropic-messages",
	provider: "anthropic",
	id: "claude-sonnet-4-6",
	name: "Claude Sonnet 4.6",
	baseUrl: "https://api.anthropic.com",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 8_192,
	contextWindow: 200_000,
	reasoning: true,
};

describe("Anthropic thinking replay immutability", () => {
	it("preserves signed-thinking blocks while normalizing non-thinking content", () => {
		const malformed = String.fromCharCode(0xd800);
		const user: UserMessage = {
			role: "user",
			content: "continue",
			timestamp: Date.now(),
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: `analysis ${malformed}`, thinkingSignature: "sig_thinking" },
				{ type: "redactedThinking", data: "" },
				{ type: "text", text: `text ${malformed}` },
				{ type: "toolCall", id: "toolu_123", name: "read", arguments: { path: "README.md", _i: "Reading file" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};

		const params = convertAnthropicMessages([user, assistant], model, false);
		const assistantParam = params.find(message => message.role === "assistant");
		expect(assistantParam).toBeDefined();
		expect(assistantParam?.content).toEqual([
			{ type: "thinking", thinking: `analysis ${malformed}`, signature: "sig_thinking" },
			{ type: "text", text: `text ${malformed.toWellFormed()}` },
			{ type: "tool_use", id: "toolu_123", name: "read", input: { path: "README.md", _i: "Reading file" } },
		]);
	});

	it("drops signed thinking blocks whose body was never captured", () => {
		// Upstream relays (e.g. OAuth Claude proxies) sometimes forward
		// signature_delta without thinking_delta, leaving an empty body paired
		// with a real signature. Replaying that verbatim trips Anthropic's
		// "thinking blocks cannot be modified" 400 on the latest assistant turn.
		const user: UserMessage = { role: "user", content: "continue", timestamp: Date.now() };
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "", thinkingSignature: "sig_empty" },
				{ type: "text", text: "answer" },
				{ type: "toolCall", id: "toolu_9", name: "read", arguments: { path: "x", _i: "Reading" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};

		const params = convertAnthropicMessages([user, assistant], model, false);
		const assistantParam = params.find(message => message.role === "assistant");
		expect(assistantParam?.content).toEqual([
			{ type: "text", text: "answer" },
			{ type: "tool_use", id: "toolu_9", name: "read", input: { path: "x", _i: "Reading" } },
		]);
	});
});

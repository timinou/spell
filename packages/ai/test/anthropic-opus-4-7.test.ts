import { describe, expect, it, mock } from "bun:test";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages";
import { Effort } from "../src/model-thinking";
import { getBundledModel } from "../src/models";
import type { Context, Model } from "../src/types";

type MockEvent = {
	type: string;
	[key: string]: unknown;
};

interface MockAnthropicStream extends AsyncIterable<MockEvent>, AsyncIterator<MockEvent> {}

type CapturedAnthropicParams = {
	thinking?: { type: string };
	output_config?: unknown;
};

let capturedParams: CapturedAnthropicParams | null = null;

function createMockAnthropicStream(events: MockEvent[]): MockAnthropicStream {
	let index = 0;
	const iterator: MockAnthropicStream = {
		[Symbol.asyncIterator]() {
			return iterator;
		},
		async next(): Promise<IteratorResult<MockEvent>> {
			if (index < events.length) {
				return { value: events[index++]!, done: false };
			}
			return { value: undefined, done: true };
		},
		async return(): Promise<IteratorResult<MockEvent>> {
			return { value: undefined, done: true };
		},
	};

	return iterator;
}

class MockAnthropic {
	messages = {
		stream: (params: MessageCreateParamsStreaming) => {
			capturedParams = params;
			return createMockAnthropicStream([
				{
					type: "message_start",
					message: {
						id: "msg_opus47",
						type: "message",
						role: "assistant",
						content: [],
						model: "claude-opus-4-7",
						stop_reason: null,
						stop_sequence: null,
						usage: {
							input_tokens: 10,
							output_tokens: 0,
							cache_creation_input_tokens: 0,
							cache_read_input_tokens: 0,
						},
					},
				},
				{
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "" },
				},
				{
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "ok" },
				},
				{ type: "content_block_stop", index: 0 },
				{
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: { output_tokens: 2 },
				},
				{ type: "message_stop" },
			]);
		},
	};
}

mock.module("@anthropic-ai/sdk", () => ({
	default: MockAnthropic,
}));

const { streamAnthropic } = await import("../src/providers/anthropic");

const model = getBundledModel("anthropic", "claude-opus-4-7") as Model<"anthropic-messages">;
const context: Context = {
	messages: [{ role: "user", content: "Say hi", timestamp: Date.now() }],
};

describe("bundled Claude Opus 4.7 metadata", () => {
	it("includes the Anthropic Claude Opus 4.7 model with expected limits", () => {
		expect(model).toBeDefined();
		expect(model.name).toBe("Claude Opus 4.7");
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(128_000);
		expect(model.cost).toEqual({
			input: 5,
			output: 25,
			cacheRead: 0.5,
			cacheWrite: 6.25,
		});
		expect(model.thinking).toMatchObject({
			mode: "anthropic-adaptive",
			minLevel: "minimal",
			maxLevel: "xhigh",
		});
	});

	it("forces adaptive thinking and ignores caller effort controls", async () => {
		capturedParams = null;

		const response = streamAnthropic(model, context, {
			apiKey: "test-key", // pragma: allowlist secret
			thinkingEnabled: false,
			reasoning: Effort.XHigh,
			effort: "max",
		});
		const result = await response.result();

		expect(result.stopReason).not.toBe("error");
		expect(result.errorMessage).toBeUndefined();
		if (!capturedParams) throw new Error("expected captured params");
		const params = capturedParams as CapturedAnthropicParams;
		expect(params.thinking).toEqual({ type: "adaptive" });
		expect(params.output_config).toBeUndefined();
	});
});

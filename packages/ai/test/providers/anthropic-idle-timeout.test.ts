import { afterEach, describe, expect, it, mock } from "bun:test";
import { getBundledModel } from "../../src/models";
import type { AssistantMessageEvent, Context, Model } from "../../src/types";

type MockEvent = {
	type: string;
	[key: string]: unknown;
};

interface MockAnthropicStream extends AsyncIterable<MockEvent>, AsyncIterator<MockEvent> {
	abortCount: number;
	returnCount: number;
}

interface MockStreamSpec {
	events: MockEvent[];
	stallAfterEvents?: boolean;
}

let streamSpecs: MockStreamSpec[] = [{ events: [] }];
let streamCallCount = 0;
let lastStream: MockAnthropicStream | null = null;
let createdStreams: MockAnthropicStream[] = [];

class MockAnthropic {
	messages = {
		stream: (_params: unknown, options?: { signal?: AbortSignal }) => {
			const spec = streamSpecs[Math.min(streamCallCount, streamSpecs.length - 1)] ?? { events: [] };
			streamCallCount += 1;
			lastStream = createMockAnthropicStream(spec.events, {
				signal: options?.signal,
				stallAfterEvents: spec.stallAfterEvents,
			});
			createdStreams.push(lastStream);
			return lastStream;
		},
	};
}

mock.module("@anthropic-ai/sdk", () => ({
	default: MockAnthropic,
}));

const { streamAnthropic } = await import("../../src/providers/anthropic");

const model = getBundledModel("anthropic", "claude-opus-4-6") as Model<"anthropic-messages">;

const context: Context = {
	messages: [{ role: "user", content: "Create the item", timestamp: Date.now() }],
};

function createMockAnthropicStream(
	events: MockEvent[],
	options: { signal?: AbortSignal; stallAfterEvents?: boolean },
): MockAnthropicStream {
	let index = 0;
	let releaseStall: (() => void) | undefined;
	const iterator: MockAnthropicStream = {
		abortCount: 0,
		returnCount: 0,
		[Symbol.asyncIterator]() {
			return iterator;
		},
		async next(): Promise<IteratorResult<MockEvent>> {
			if (index < events.length) {
				return { value: events[index++]!, done: false };
			}
			if (options.stallAfterEvents) {
				await new Promise<void>(resolve => {
					releaseStall = resolve;
				});
			}
			return { value: undefined, done: true };
		},
		async return(): Promise<IteratorResult<MockEvent>> {
			iterator.returnCount += 1;
			releaseStall?.();
			return { value: undefined, done: true };
		},
	};

	options.signal?.addEventListener(
		"abort",
		() => {
			iterator.abortCount += 1;
			releaseStall?.();
		},
		{ once: true },
	);

	return iterator;
}

function configureStream(events: MockEvent[], options: { stallAfterEvents?: boolean } = {}): void {
	configureStreamSequence([{ events, stallAfterEvents: options.stallAfterEvents }]);
}

function configureStreamSequence(specs: MockStreamSpec[]): void {
	streamSpecs = specs;
	streamCallCount = 0;
	lastStream = null;
	createdStreams = [];
}

function buildToolUseEvents(options: {
	toolName?: string;
	partialJson?: string;
	closeToolBlock?: boolean;
	includeTerminalMessage: boolean;
}): MockEvent[] {
	const usage = {
		input_tokens: 12,
		output_tokens: 0,
		cache_read_input_tokens: 0,
		cache_creation_input_tokens: 0,
	};
	const events: MockEvent[] = [
		{ type: "message_start", message: { usage } },
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "toolu_123", name: options.toolName ?? "org", input: {} },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: {
				type: "input_json_delta",
				partial_json: options.partialJson ?? '{"_i":"Creating org item","command":"create","category":"features"}',
			},
		},
	];
	if (options.closeToolBlock !== false) {
		events.push({ type: "content_block_stop", index: 0 });
	}
	if (options.includeTerminalMessage) {
		events.push(
			{
				type: "message_delta",
				delta: { stop_reason: "tool_use" },
				usage: {
					input_tokens: 12,
					output_tokens: 5,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
			{ type: "message_stop" },
		);
	}
	return events;
}
function buildTextEvents(text: string): MockEvent[] {
	const usage = {
		input_tokens: 12,
		output_tokens: 0,
		cache_read_input_tokens: 0,
		cache_creation_input_tokens: 0,
	};
	return [
		{ type: "message_start", message: { usage } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
	];
}

async function collectEventTypes(response: AsyncIterable<AssistantMessageEvent>): Promise<string[]> {
	const eventTypes: string[] = [];
	for await (const event of response) {
		eventTypes.push(event.type);
	}
	return eventTypes;
}

afterEach(() => {
	delete Bun.env.PI_ANTHROPIC_STREAM_IDLE_TIMEOUT_MS;
	delete Bun.env.PI_TOOL_ARGUMENT_STREAM_IDLE_TIMEOUT_MS;
	lastStream = null;
	createdStreams = [];
	streamSpecs = [{ events: [] }];
	streamCallCount = 0;
});

describe("Anthropic provider idle timeout regression", () => {
	it("surfaces an error and aborts the request when the stream never starts", async () => {
		Bun.env.PI_ANTHROPIC_STREAM_IDLE_TIMEOUT_MS = "10";
		configureStream([], { stallAfterEvents: true });

		const response = streamAnthropic(model, context, { apiKey: "test-key" });
		const eventTypes = await collectEventTypes(response);
		const result = await response.result();
		const diagnostic = result.streamDiagnostics?.[0];

		expect(eventTypes).toEqual(["start", "error"]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Assistant response stalled before any response content arrived.");
		expect(diagnostic?.state).toBe("stalled_before_response_content");
		expect(diagnostic?.idleTimeoutMs).toBe(10);
		expect(lastStream?.abortCount).toBe(1);
		expect(lastStream?.returnCount).toBe(1);
	});

	it("fails truthfully when Anthropic stalls after text has started", async () => {
		Bun.env.PI_ANTHROPIC_STREAM_IDLE_TIMEOUT_MS = "10";
		configureStream(buildTextEvents("Draft intro"), { stallAfterEvents: true });

		const response = streamAnthropic(model, context, { apiKey: "test-key" });
		const eventTypes = await collectEventTypes(response);
		const result = await response.result();
		const diagnostic = result.streamDiagnostics?.[0];
		const textBlock = result.content.find(block => block.type === "text");

		expect(eventTypes).toEqual(["start", "text_start", "text_delta", "error"]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Assistant response stalled while streaming text content.");
		expect(diagnostic?.state).toBe("stalled_during_text");
		expect(textBlock).toEqual({ type: "text", text: "Draft intro" });
		expect(createdStreams).toHaveLength(1);
	});

	it("retries an incomplete stalled tool call instead of surfacing a partial write", async () => {
		Bun.env.PI_ANTHROPIC_STREAM_IDLE_TIMEOUT_MS = "10";
		Bun.env.PI_TOOL_ARGUMENT_STREAM_IDLE_TIMEOUT_MS = "10";
		configureStreamSequence([
			{
				events: buildToolUseEvents({
					toolName: "write",
					partialJson: '{"path":"specs/markdown-code-engine-integration.md"}',
					closeToolBlock: false,
					includeTerminalMessage: false,
				}),
				stallAfterEvents: true,
			},
			{
				events: buildToolUseEvents({
					toolName: "write",
					partialJson: '{"path":"specs/markdown-code-engine-integration.md","content":"draft"}',
					includeTerminalMessage: true,
				}),
			},
		]);

		const response = streamAnthropic(model, context, { apiKey: "test-key" });
		const eventTypes = await collectEventTypes(response);
		const result = await response.result();
		const toolCall = result.content.find(block => block.type === "toolCall");
		const diagnostics = result.streamDiagnostics ?? [];

		expect(createdStreams).toHaveLength(2);
		expect(createdStreams[0]?.abortCount).toBe(1);
		expect(createdStreams[0]?.returnCount).toBe(1);
		expect(createdStreams[1]?.abortCount).toBe(0);
		expect(eventTypes).toContain("toolcall_end");
		expect(eventTypes.at(-1)).toBe("done");
		expect(result.stopReason).toBe("toolUse");
		expect(diagnostics.map(diagnostic => diagnostic.state)).toContain("stalled_incomplete_tool_args");
		if (toolCall?.type !== "toolCall") {
			throw new Error("Expected recovered write tool call after provider retry");
		}
		expect(toolCall.name).toBe("write");
		expect(toolCall.arguments).toEqual({
			path: "specs/markdown-code-engine-integration.md",
			content: "draft",
		});
	});

	it("recovers a completed tool call when Anthropic stalls before trailing stop events", async () => {
		Bun.env.PI_ANTHROPIC_STREAM_IDLE_TIMEOUT_MS = "10";
		configureStream(buildToolUseEvents({ includeTerminalMessage: false }), { stallAfterEvents: true });

		const response = streamAnthropic(model, context, { apiKey: "test-key" });
		const eventTypes = await collectEventTypes(response);
		const result = await response.result();
		const toolCall = result.content.find(block => block.type === "toolCall");

		expect(eventTypes).toContain("toolcall_end");
		expect(eventTypes.at(-1)).toBe("done");
		expect(result.stopReason).toBe("toolUse");
		expect(toolCall?.type).toBe("toolCall");
		if (toolCall?.type !== "toolCall") {
			throw new Error("Expected completed tool call in recovered response");
		}
		expect(toolCall.name).toBe("org");
		expect(toolCall.arguments).toEqual({
			_i: "Creating org item",
			command: "create",
			category: "features",
		});
		expect(lastStream?.abortCount).toBe(1);
		expect(lastStream?.returnCount).toBe(1);
	});

	it("still completes healthy tool-use streams normally", async () => {
		Bun.env.PI_ANTHROPIC_STREAM_IDLE_TIMEOUT_MS = "10";
		configureStream(buildToolUseEvents({ includeTerminalMessage: true }));

		const response = streamAnthropic(model, context, { apiKey: "test-key" });
		const eventTypes = await collectEventTypes(response);
		const result = await response.result();

		expect(eventTypes.at(-1)).toBe("done");
		expect(result.stopReason).toBe("toolUse");
		expect(result.errorMessage).toBeUndefined();
		expect(lastStream?.abortCount).toBe(0);
		expect(lastStream?.returnCount).toBe(0);
	});
});

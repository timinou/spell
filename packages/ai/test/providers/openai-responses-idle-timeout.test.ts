import { afterEach, describe, expect, it, mock } from "bun:test";
import { getBundledModel } from "../../src/models";
import type { AssistantMessageEvent, Context, Model } from "../../src/types";

type MockEvent = {
	type: string;
	[key: string]: unknown;
};

interface MockResponsesStream extends AsyncIterable<MockEvent>, AsyncIterator<MockEvent> {
	abortCount: number;
	returnCount: number;
}

interface MockEventSpec {
	event: MockEvent;
	delayMs?: number;
}

interface MockStreamSpec {
	events: MockEventSpec[];
	stallAfterEvents?: boolean;
}

let streamSpecs: MockStreamSpec[] = [{ events: [] }];
let streamCallCount = 0;
let lastStream: MockResponsesStream | null = null;
let createdStreams: MockResponsesStream[] = [];

class MockOpenAI {
	responses = {
		create: (_params: unknown, options?: { signal?: AbortSignal }) => {
			const spec = streamSpecs[Math.min(streamCallCount, streamSpecs.length - 1)] ?? { events: [] };
			streamCallCount += 1;
			lastStream = createMockResponsesStream(spec, options?.signal);
			createdStreams.push(lastStream);
			return lastStream;
		},
	};
}

mock.module("openai", () => ({
	default: MockOpenAI,
	AzureOpenAI: class MockAzureOpenAI {},
}));

const { streamOpenAIResponses } = await import("../../src/providers/openai-responses");

const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;

const context: Context = {
	messages: [{ role: "user", content: "Create the file", timestamp: Date.now() }],
};

function createMockResponsesStream(spec: MockStreamSpec, signal?: AbortSignal): MockResponsesStream {
	let index = 0;
	let releaseStall: (() => void) | undefined;
	const iterator: MockResponsesStream = {
		abortCount: 0,
		returnCount: 0,
		[Symbol.asyncIterator]() {
			return iterator;
		},
		async next(): Promise<IteratorResult<MockEvent>> {
			if (index < spec.events.length) {
				const next = spec.events[index++]!;
				if (next.delayMs) {
					await Bun.sleep(next.delayMs);
				}
				return { value: next.event, done: false };
			}
			if (spec.stallAfterEvents) {
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

	signal?.addEventListener(
		"abort",
		() => {
			iterator.abortCount += 1;
			releaseStall?.();
		},
		{ once: true },
	);

	return iterator;
}

function configureStreamSequence(specs: MockStreamSpec[]): void {
	streamSpecs = specs;
	streamCallCount = 0;
	lastStream = null;
	createdStreams = [];
}

function buildFunctionCallEvents(options: {
	partialJson: string;
	finalJson?: string;
	delayBeforeDoneMs?: number;
	includeCompleted?: boolean;
}): MockEventSpec[] {
	const finalJson = options.finalJson ?? options.partialJson;
	const events: MockEventSpec[] = [
		{
			event: {
				type: "response.output_item.added",
				item: {
					type: "function_call",
					call_id: "call_1",
					id: "fc_1",
					name: "write",
					arguments: "",
				},
			},
		},
		{
			event: {
				type: "response.function_call_arguments.delta",
				delta: options.partialJson,
			},
		},
	];
	if (options.includeCompleted !== false) {
		if (options.delayBeforeDoneMs) {
			events.push({
				event: {
					type: "response.output_item.done",
					item: {
						type: "function_call",
						call_id: "call_1",
						id: "fc_1",
						name: "write",
						arguments: finalJson,
					},
				},
				delayMs: options.delayBeforeDoneMs,
			});
		} else {
			events.push({
				event: {
					type: "response.output_item.done",
					item: {
						type: "function_call",
						call_id: "call_1",
						id: "fc_1",
						name: "write",
						arguments: finalJson,
					},
				},
			});
		}
		events.push({
			event: {
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 12,
						output_tokens: 5,
						total_tokens: 17,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		});
	}
	return events;
}

async function collectEventTypes(response: AsyncIterable<AssistantMessageEvent>): Promise<string[]> {
	const eventTypes: string[] = [];
	for await (const event of response) {
		eventTypes.push(event.type);
	}
	return eventTypes;
}

afterEach(() => {
	delete Bun.env.PI_OPENAI_STREAM_IDLE_TIMEOUT_MS;
	delete Bun.env.PI_TOOL_ARGUMENT_STREAM_IDLE_TIMEOUT_MS;
	lastStream = null;
	createdStreams = [];
	streamSpecs = [{ events: [] }];
	streamCallCount = 0;
});

describe("OpenAI responses provider idle timeout regression", () => {
	it("extends the idle timeout while tool arguments are streaming", async () => {
		Bun.env.PI_OPENAI_STREAM_IDLE_TIMEOUT_MS = "10";
		Bun.env.PI_TOOL_ARGUMENT_STREAM_IDLE_TIMEOUT_MS = "40";
		configureStreamSequence([
			{
				events: buildFunctionCallEvents({
					partialJson: '{"path":"specs/markdown-code-engine-integration.md","content":"draft"}',
					delayBeforeDoneMs: 20,
				}),
			},
		]);

		const response = streamOpenAIResponses(model, context, { apiKey: "test-key" });
		const eventTypes = await collectEventTypes(response);
		const result = await response.result();
		const toolCall = result.content.find(block => block.type === "toolCall");

		expect(createdStreams).toHaveLength(1);
		expect(lastStream?.abortCount).toBe(0);
		expect(eventTypes).toContain("toolcall_end");
		expect(eventTypes.at(-1)).toBe("done");
		expect(result.stopReason).toBe("toolUse");
		expect(result.streamDiagnostics).toBeUndefined();
		if (toolCall?.type !== "toolCall") {
			throw new Error("Expected completed write tool call after extended idle budget");
		}
		expect(toolCall.arguments).toEqual({
			path: "specs/markdown-code-engine-integration.md",
			content: "draft",
		});
	});

	it("retries incomplete stalled tool arguments with shared diagnostics", async () => {
		Bun.env.PI_OPENAI_STREAM_IDLE_TIMEOUT_MS = "10";
		Bun.env.PI_TOOL_ARGUMENT_STREAM_IDLE_TIMEOUT_MS = "10";
		configureStreamSequence([
			{
				events: buildFunctionCallEvents({
					partialJson: '{"path":"specs/markdown-code-engine-integration.md"}',
					includeCompleted: false,
				}),
				stallAfterEvents: true,
			},
			{
				events: buildFunctionCallEvents({
					partialJson: '{"path":"specs/markdown-code-engine-integration.md","content":"draft"}',
				}),
			},
		]);

		const response = streamOpenAIResponses(model, context, { apiKey: "test-key" });
		const eventTypes = await collectEventTypes(response);
		const result = await response.result();
		const toolCall = result.content.find(block => block.type === "toolCall");
		const diagnostic = result.streamDiagnostics?.[0];

		expect(createdStreams).toHaveLength(2);
		expect(createdStreams[0]?.abortCount).toBe(1);
		expect(createdStreams[0]?.returnCount).toBe(1);
		expect(eventTypes).toContain("toolcall_end");
		expect(eventTypes.at(-1)).toBe("done");
		expect(result.stopReason).toBe("toolUse");
		expect(diagnostic).toMatchObject({
			state: "stalled_incomplete_tool_args",
			toolName: "write",
			parsedArgumentKeys: ["path"],
			providerRetryAttempt: 0,
		});
		expect(diagnostic?.rawPartialJson).toBe('{"path":"specs/markdown-code-engine-integration.md"}');
		if (toolCall?.type !== "toolCall") {
			throw new Error("Expected recovered write tool call after provider retry");
		}
		expect(toolCall.arguments).toEqual({
			path: "specs/markdown-code-engine-integration.md",
			content: "draft",
		});
	});
});

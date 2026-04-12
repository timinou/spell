import { afterEach, describe, expect, it, mock } from "bun:test";
import type { AssistantMessageEvent, Context, Model } from "../../src/types";

type MockEvent = {
	type: string;
	[key: string]: unknown;
};

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
let createdStreams: MockStream[] = [];

interface MockStream extends AsyncIterable<MockEvent>, AsyncIterator<MockEvent> {
	abortCount: number;
	returnCount: number;
}

class MockAzureOpenAI {
	responses = {
		create: (_params: unknown, options?: { signal?: AbortSignal }) => {
			const spec = streamSpecs[Math.min(streamCallCount, streamSpecs.length - 1)] ?? { events: [] };
			streamCallCount += 1;
			const stream = createMockStream(spec, options?.signal);
			createdStreams.push(stream);
			return stream;
		},
	};
}

mock.module("openai", () => ({
	default: class {},
	AzureOpenAI: MockAzureOpenAI,
}));

const { streamAzureOpenAIResponses } = await import("../../src/providers/azure-openai-responses");

const model = {
	id: "gpt-4o",
	provider: "azure-openai",
	api: "azure-openai-responses",
	baseUrl: "https://test-resource.openai.azure.com/openai/v1",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	input: ["text"],
	name: "GPT-4o",
} as unknown as Model<"azure-openai-responses">;

const context: Context = {
	messages: [{ role: "user", content: "Create the file", timestamp: Date.now() }],
};

function createMockStream(spec: MockStreamSpec, signal?: AbortSignal): MockStream {
	let index = 0;
	let releaseStall: (() => void) | undefined;
	const iterator: MockStream = {
		abortCount: 0,
		returnCount: 0,
		[Symbol.asyncIterator]() {
			return iterator;
		},
		async next(): Promise<IteratorResult<MockEvent>> {
			if (index < spec.events.length) {
				const next = spec.events[index++]!;
				if (next.delayMs) await Bun.sleep(next.delayMs);
				return { value: next.event, done: false };
			}
			if (spec.stallAfterEvents) {
				await new Promise<void>(resolve => {
					releaseStall = resolve;
				});
			}
			return { value: undefined as unknown as MockEvent, done: true };
		},
		async return(): Promise<IteratorResult<MockEvent>> {
			iterator.returnCount += 1;
			releaseStall?.();
			return { value: undefined as unknown as MockEvent, done: true };
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
	createdStreams = [];
}

function buildFunctionCallEvents(options: {
	partialJson: string;
	finalJson?: string;
	includeCompleted?: boolean;
}): MockEventSpec[] {
	const finalJson = options.finalJson ?? options.partialJson;
	const events: MockEventSpec[] = [
		{
			event: {
				type: "response.output_item.added",
				item: { type: "function_call", call_id: "call_1", id: "fc_1", name: "write", arguments: "" },
			},
		},
		{
			event: { type: "response.function_call_arguments.delta", delta: options.partialJson },
		},
	];
	if (options.includeCompleted !== false) {
		events.push(
			{
				event: {
					type: "response.output_item.done",
					item: { type: "function_call", call_id: "call_1", id: "fc_1", name: "write", arguments: finalJson },
				},
			},
			{
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
			},
		);
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
	createdStreams = [];
	streamSpecs = [{ events: [] }];
	streamCallCount = 0;
});

describe("Azure OpenAI responses provider idle timeout regression", () => {
	it("retries incomplete stalled tool arguments with shared diagnostics", async () => {
		Bun.env.PI_OPENAI_STREAM_IDLE_TIMEOUT_MS = "10";
		Bun.env.PI_TOOL_ARGUMENT_STREAM_IDLE_TIMEOUT_MS = "10";
		configureStreamSequence([
			{
				events: buildFunctionCallEvents({
					partialJson: '{"path":"specs/test.md"}',
					includeCompleted: false,
				}),
				stallAfterEvents: true,
			},
			{
				events: buildFunctionCallEvents({
					partialJson: '{"path":"specs/test.md","content":"draft"}',
				}),
			},
		]);

		const response = streamAzureOpenAIResponses(model, context, { apiKey: "test-key" });
		const eventTypes = await collectEventTypes(response);
		const result = await response.result();
		const diagnostic = result.streamDiagnostics?.[0];

		expect(createdStreams).toHaveLength(2);
		expect(createdStreams[0]?.abortCount).toBe(1);
		expect(eventTypes).toContain("toolcall_end");
		expect(eventTypes.at(-1)).toBe("done");
		expect(result.stopReason).toBe("toolUse");
		expect(diagnostic?.state).toBe("stalled_incomplete_tool_args");
		expect(diagnostic?.toolName).toBe("write");
	});

	it("completes healthy streams normally", async () => {
		Bun.env.PI_OPENAI_STREAM_IDLE_TIMEOUT_MS = "10";
		configureStreamSequence([
			{
				events: buildFunctionCallEvents({
					partialJson: '{"path":"specs/test.md","content":"draft"}',
				}),
			},
		]);

		const response = streamAzureOpenAIResponses(model, context, { apiKey: "test-key" });
		const eventTypes = await collectEventTypes(response);
		const result = await response.result();

		expect(eventTypes.at(-1)).toBe("done");
		expect(result.stopReason).toBe("toolUse");
		expect(result.streamDiagnostics).toBeUndefined();
	});
});

import { afterEach, describe, expect, it, mock } from "bun:test";
import type { AssistantMessageEvent, Context, Model } from "../../src/types";

type MockStreamItem = Record<string, unknown>;

interface MockBedrockStream extends AsyncIterable<MockStreamItem>, AsyncIterator<MockStreamItem> {
	abortCount: number;
	returnCount: number;
}

interface MockStreamSpec {
	events: MockStreamItem[];
	stallAfterEvents?: boolean;
}

let streamSpecs: MockStreamSpec[] = [{ events: [] }];
let streamCallCount = 0;
let lastStream: MockBedrockStream | null = null;
let createdStreams: MockBedrockStream[] = [];

class MockBedrockRuntimeClient {
	send = async (_command: unknown, options?: { abortSignal?: AbortSignal }) => {
		const spec = streamSpecs[Math.min(streamCallCount, streamSpecs.length - 1)] ?? { events: [] };
		streamCallCount += 1;
		lastStream = createMockBedrockStream(spec.events, {
			abortSignal: options?.abortSignal,
			stallAfterEvents: spec.stallAfterEvents,
		});
		createdStreams.push(lastStream);
		return { stream: lastStream };
	};
}

mock.module("@aws-sdk/client-bedrock-runtime", () => ({
	BedrockRuntimeClient: MockBedrockRuntimeClient,
	ConverseStreamCommand: class {
		constructor(public input: unknown) {}
	},
	ConversationRole: { ASSISTANT: "assistant", USER: "user" },
	StopReason: { TOOL_USE: "tool_use", END_TURN: "end_turn" },
	CachePointType: { DEFAULT: "default" },
	CacheTTL: { ONE_HOUR: "one_hour" },
	ImageFormat: { PNG: "png", JPEG: "jpeg", GIF: "gif", WEBP: "webp" },
	ToolResultStatus: { SUCCESS: "success", ERROR: "error" },
}));

mock.module("@smithy/node-http-handler", () => ({
	NodeHttpHandler: class {},
}));

const { streamBedrock } = await import("../../src/providers/amazon-bedrock");

const model = {
	id: "us.anthropic.claude-sonnet-4-20250514-v1:0",
	provider: "amazon-bedrock",
	api: "bedrock-converse-stream",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as Model<"bedrock-converse-stream">;

const context: Context = {
	messages: [{ role: "user", content: "Create the item", timestamp: Date.now() }],
};

function createMockBedrockStream(
	events: MockStreamItem[],
	options: { abortSignal?: AbortSignal; stallAfterEvents?: boolean },
): MockBedrockStream {
	let index = 0;
	let releaseStall: (() => void) | undefined;
	const iterator: MockBedrockStream = {
		abortCount: 0,
		returnCount: 0,
		[Symbol.asyncIterator]() {
			return iterator;
		},
		async next(): Promise<IteratorResult<MockStreamItem>> {
			if (index < events.length) {
				return { value: events[index++]!, done: false };
			}
			if (options.stallAfterEvents) {
				await new Promise<void>(resolve => {
					releaseStall = resolve;
				});
			}
			return { value: undefined as unknown as MockStreamItem, done: true };
		},
		async return(): Promise<IteratorResult<MockStreamItem>> {
			iterator.returnCount += 1;
			releaseStall?.();
			return { value: undefined as unknown as MockStreamItem, done: true };
		},
	};

	options.abortSignal?.addEventListener(
		"abort",
		() => {
			iterator.abortCount += 1;
			releaseStall?.();
		},
		{ once: true },
	);

	return iterator;
}

function configureStream(events: MockStreamItem[], options: { stallAfterEvents?: boolean } = {}): void {
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
}): MockStreamItem[] {
	const events: MockStreamItem[] = [
		{ messageStart: { role: "assistant" } },
		{
			contentBlockStart: {
				start: { toolUse: { toolUseId: "toolu_123", name: options.toolName ?? "org" } },
				contentBlockIndex: 0,
			},
		},
		{
			contentBlockDelta: {
				delta: {
					toolUse: {
						input: options.partialJson ?? '{"_i":"Creating org item","command":"create","category":"features"}',
					},
				},
				contentBlockIndex: 0,
			},
		},
	];
	if (options.closeToolBlock !== false) {
		events.push({ contentBlockStop: { contentBlockIndex: 0 } });
	}
	if (options.includeTerminalMessage) {
		events.push(
			{ messageStop: { stopReason: "tool_use" } },
			{ metadata: { usage: { inputTokens: 12, outputTokens: 5 } } },
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
	delete Bun.env.PI_BEDROCK_STREAM_IDLE_TIMEOUT_MS;
	delete Bun.env.PI_TOOL_ARGUMENT_STREAM_IDLE_TIMEOUT_MS;
	lastStream = null;
	createdStreams = [];
	streamSpecs = [{ events: [] }];
	streamCallCount = 0;
});

describe("Bedrock provider idle timeout regression", () => {
	it("surfaces an error and aborts the request when the stream stalls", async () => {
		Bun.env.PI_BEDROCK_STREAM_IDLE_TIMEOUT_MS = "10";
		configureStream([], { stallAfterEvents: true });

		const response = streamBedrock(model, context, { region: "us-east-1" });
		const eventTypes = await collectEventTypes(response);
		const result = await response.result();

		expect(eventTypes).toEqual(["start", "error"]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Bedrock stream stalled while waiting for the next event");
		expect(lastStream?.abortCount).toBe(1);
		expect(lastStream?.returnCount).toBe(1);
	});

	it("retries an incomplete stalled tool call", async () => {
		Bun.env.PI_BEDROCK_STREAM_IDLE_TIMEOUT_MS = "10";
		Bun.env.PI_TOOL_ARGUMENT_STREAM_IDLE_TIMEOUT_MS = "10";
		configureStreamSequence([
			{
				events: buildToolUseEvents({
					toolName: "write",
					partialJson: '{"path":"specs/test.md"',
					closeToolBlock: false,
					includeTerminalMessage: false,
				}),
				stallAfterEvents: true,
			},
			{
				events: buildToolUseEvents({
					toolName: "write",
					partialJson: '{"path":"specs/test.md","content":"draft"}',
					includeTerminalMessage: true,
				}),
			},
		]);

		const response = streamBedrock(model, context, { region: "us-east-1" });
		const eventTypes = await collectEventTypes(response);
		const result = await response.result();
		const toolCall = result.content.find(block => block.type === "toolCall");

		expect(createdStreams).toHaveLength(2);
		expect(createdStreams[0]?.abortCount).toBe(1);
		expect(eventTypes).toContain("toolcall_end");
		expect(eventTypes.at(-1)).toBe("done");
		expect(result.stopReason).toBe("toolUse");
		if (toolCall?.type !== "toolCall") throw new Error("Expected recovered tool call");
		expect(toolCall.name).toBe("write");
		expect(toolCall.arguments).toEqual({ path: "specs/test.md", content: "draft" });
	});

	it("recovers a completed tool call when Bedrock stalls before trailing stop events", async () => {
		Bun.env.PI_BEDROCK_STREAM_IDLE_TIMEOUT_MS = "10";
		configureStream(buildToolUseEvents({ includeTerminalMessage: false }), { stallAfterEvents: true });

		const response = streamBedrock(model, context, { region: "us-east-1" });
		const eventTypes = await collectEventTypes(response);
		const result = await response.result();

		expect(eventTypes).toContain("toolcall_end");
		expect(eventTypes.at(-1)).toBe("done");
		expect(result.stopReason).toBe("toolUse");
		expect(lastStream?.abortCount).toBe(1);
	});

	it("completes healthy tool-use streams normally", async () => {
		Bun.env.PI_BEDROCK_STREAM_IDLE_TIMEOUT_MS = "10";
		configureStream(buildToolUseEvents({ includeTerminalMessage: true }));

		const response = streamBedrock(model, context, { region: "us-east-1" });
		const eventTypes = await collectEventTypes(response);
		const result = await response.result();

		expect(eventTypes.at(-1)).toBe("done");
		expect(result.stopReason).toBe("toolUse");
		expect(result.content.some(block => block.type === "toolCall")).toBe(true);
	});
});

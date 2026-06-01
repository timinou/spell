import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { INTENT_FIELD } from "@spell/pi-agent-core";
import { setAnthropicStreamIdleTimeoutOverrideMs } from "@spell/pi-ai";
import {
	EventController,
	STREAM_IDLE_STATUS_GRACE_MS,
	STREAM_IDLE_STATUS_INTERVAL_MS,
} from "../../src/modes/controllers/event-controller";
import { initTheme } from "../../src/modes/theme/theme";

interface ControllerFixture {
	controller: EventController;
	workingMessages: string[];
	ctx: ConstructorParameters<typeof EventController>[0];
}
beforeAll(async () => {
	await initTheme(false);
});

function assistantEvent(type: string, content: unknown[] = []): never {
	return {
		type: "message_update",
		message: { role: "assistant", content },
		assistantMessageEvent: { type },
	} as never;
}

function createFixture(options: { provider?: string; pendingToolIntent?: string } = {}): ControllerFixture {
	const workingMessages: string[] = [];
	const pendingTools = new Map<string, { updateArgs: () => void; setArgsComplete: () => void }>();
	if (options.pendingToolIntent !== undefined) {
		pendingTools.set("tool-1", { updateArgs: () => {}, setArgsComplete: () => {} });
	}

	const ctx = {
		isInitialized: true,
		init: async () => {},
		statusLine: { invalidate: () => {}, setCanvasTaskCount: () => {} },
		updateEditorTopBorder: () => {},
		streamingComponent: { updateContent: () => {}, setUsageInfo: () => {} },
		streamingMessage: undefined,
		pendingTools,
		ui: { requestRender: () => {} },
		setWorkingMessage: (message?: string) => {
			if (message) workingMessages.push(message);
		},
		session: {
			retryAttempt: 0,
			isTtsrAbortPending: false,
			model: { provider: options.provider ?? "anthropic", id: "claude-opus" },
			getToolByName: () => undefined,
		},
		taskManager: undefined,
		chatContainer: { removeChild: () => {} },
		loadingAnimation: undefined,
		statusContainer: { clear: () => {}, addChild: () => {} },
		editor: { onEscape: () => {} },
		retryLoader: undefined,
		pendingToolsContainer: undefined,
		flushPendingModelSwitch: async () => {},
		isBackgrounded: false,
		sessionManager: { getSessionName: () => "test" },
	} as unknown as ConstructorParameters<typeof EventController>[0];

	return { controller: new EventController(ctx), workingMessages, ctx };
}

describe("stream idle keepalive status", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		setAnthropicStreamIdleTimeoutOverrideMs(undefined);
	});

	afterEach(() => {
		vi.useRealTimers();
		setAnthropicStreamIdleTimeoutOverrideMs(undefined);
	});

	it("updates the working message during a silent thinking stream", async () => {
		const { controller, workingMessages } = createFixture();

		await controller.handleEvent(
			assistantEvent("thinking_delta", [{ type: "thinking", thinking: "private chain of thought" }]),
		);
		vi.advanceTimersByTime(STREAM_IDLE_STATUS_GRACE_MS - 1);
		expect(workingMessages).toEqual([]);

		vi.advanceTimersByTime(1);

		expect(workingMessages.at(-1)).toBe("Thinking for 5s; last token 5s ago; timeout 180s (esc to interrupt)");
		expect(workingMessages.join("\n")).not.toContain("private chain of thought");
	});

	it("resets the idle counter when another thinking delta arrives", async () => {
		const { controller, workingMessages } = createFixture();

		await controller.handleEvent(assistantEvent("thinking_delta", [{ type: "thinking", thinking: "first" }]));
		vi.advanceTimersByTime(4_000);
		await controller.handleEvent(assistantEvent("thinking_delta", [{ type: "thinking", thinking: "second secret" }]));
		vi.advanceTimersByTime(STREAM_IDLE_STATUS_GRACE_MS - 1);
		expect(workingMessages).toEqual([]);

		vi.advanceTimersByTime(1);

		expect(workingMessages.at(-1)).toBe("Thinking for 9s; last token 5s ago; timeout 180s (esc to interrupt)");
		expect(workingMessages.join("\n")).not.toContain("second secret");
	});

	it("switches phase from thinking to response on text deltas", async () => {
		const { controller, workingMessages } = createFixture();

		await controller.handleEvent(assistantEvent("thinking_delta", [{ type: "thinking", thinking: "hidden" }]));
		vi.advanceTimersByTime(2_000);
		await controller.handleEvent(assistantEvent("text_delta", [{ type: "text", text: "visible answer" }]));
		vi.advanceTimersByTime(STREAM_IDLE_STATUS_GRACE_MS);

		expect(workingMessages.at(-1)).toBe("Responding for 7s; last token 5s ago; timeout 180s (esc to interrupt)");
	});

	it("updates on the repeat cadence while the stream remains silent", async () => {
		const { controller, workingMessages } = createFixture();

		await controller.handleEvent(assistantEvent("thinking_delta", [{ type: "thinking", thinking: "hidden" }]));
		vi.advanceTimersByTime(STREAM_IDLE_STATUS_GRACE_MS);
		vi.advanceTimersByTime(STREAM_IDLE_STATUS_INTERVAL_MS);

		expect(workingMessages).toEqual([
			"Thinking for 5s; last token 5s ago; timeout 180s (esc to interrupt)",
			"Thinking for 10s; last token 10s ago; timeout 180s (esc to interrupt)",
		]);
	});

	it("stops the timer on message_end", async () => {
		const { controller, workingMessages } = createFixture();

		await controller.handleEvent(assistantEvent("thinking_delta", [{ type: "thinking", thinking: "hidden" }]));
		await controller.handleEvent({
			type: "message_end",
			message: { role: "assistant", content: [], stopReason: "stop", usage: {} },
		} as never);
		vi.advanceTimersByTime(STREAM_IDLE_STATUS_GRACE_MS + STREAM_IDLE_STATUS_INTERVAL_MS);

		expect(workingMessages).toEqual([]);
	});

	it("cleans up status timers on agent_end and retry transitions", async () => {
		const first = createFixture();
		await first.controller.handleEvent(assistantEvent("thinking_delta", [{ type: "thinking", thinking: "hidden" }]));
		await first.controller.handleEvent({ type: "agent_end", messages: [] } as never);
		vi.advanceTimersByTime(STREAM_IDLE_STATUS_GRACE_MS);
		expect(first.workingMessages).toEqual([]);

		const second = createFixture();
		await second.controller.handleEvent(assistantEvent("thinking_delta", [{ type: "thinking", thinking: "hidden" }]));
		await second.controller.handleEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 2,
			delayMs: 1_000,
			errorMessage: "retrying",
		} as never);
		vi.advanceTimersByTime(STREAM_IDLE_STATUS_GRACE_MS);
		expect(second.workingMessages).toEqual([]);
	});

	it("does not overwrite a streamed tool intent with generic keepalive", async () => {
		const { controller, workingMessages } = createFixture({ pendingToolIntent: "Searching docs" });

		await controller.handleEvent({
			type: "message_update",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tool-1",
						name: "grep",
						arguments: { [INTENT_FIELD]: "Searching docs" },
						partialJson: '{"_i":"Searching docs"}',
					},
				],
			},
			assistantMessageEvent: { type: "toolcall_delta" },
		} as never);

		vi.advanceTimersByTime(STREAM_IDLE_STATUS_GRACE_MS + STREAM_IDLE_STATUS_INTERVAL_MS);

		expect(workingMessages).toEqual(["Searching docs (esc to interrupt)"]);
	});
});

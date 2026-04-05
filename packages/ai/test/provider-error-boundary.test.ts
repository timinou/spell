import { describe, expect, it } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent, Model } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { pushFallbackError } from "@oh-my-pi/pi-ai/utils/provider-error-boundary";

function createTestModel(): Model<"openai-responses"> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

describe("pushFallbackError", () => {
	it("pushes error event and ends stream when called on a live stream", async () => {
		const stream = new AssistantMessageEventStream();
		const model = createTestModel();

		pushFallbackError(stream, model, new Error("finalizeErrorMessage blew up"));

		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		expect(events.length).toBe(1);
		expect(events[0].type).toBe("error");
		const errorEvent = events[0] as { type: "error"; reason: string; error: AssistantMessage };
		expect(errorEvent.reason).toBe("error");
		expect(errorEvent.error.stopReason).toBe("error");
		expect(errorEvent.error.errorMessage).toContain("Provider error handling failed");
		expect(errorEvent.error.errorMessage).toContain("finalizeErrorMessage blew up");
		expect(errorEvent.error.model).toBe("test-model");
		expect(errorEvent.error.provider).toBe("openai");
	});

	it("does not throw when stream is already ended", () => {
		const stream = new AssistantMessageEventStream();
		const model = createTestModel();

		// End the stream first
		stream.push({
			type: "done",
			reason: "stop",
			message: {
				role: "assistant",
				content: [],
				api: "openai-responses",
				provider: "openai",
				model: "test-model",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		});

		// Should not throw even though stream is already done
		expect(() => pushFallbackError(stream, model, new Error("late error"))).not.toThrow();
	});

	it("handles non-Error objects as the error argument", async () => {
		const stream = new AssistantMessageEventStream();
		const model = createTestModel();

		pushFallbackError(stream, model, "string error");

		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const errorEvent = events[0] as { type: "error"; error: AssistantMessage };
		expect(errorEvent.error.errorMessage).toContain("string error");
	});

	it("produces a valid AssistantMessage with zeroed usage", async () => {
		const stream = new AssistantMessageEventStream();
		const model = createTestModel();

		pushFallbackError(stream, model, new Error("boom"));

		const result = await stream.result();
		expect(result.role).toBe("assistant");
		expect(result.content).toEqual([]);
		expect(result.usage.input).toBe(0);
		expect(result.usage.output).toBe(0);
		expect(result.usage.totalTokens).toBe(0);
		expect(result.usage.cost.total).toBe(0);
	});
});

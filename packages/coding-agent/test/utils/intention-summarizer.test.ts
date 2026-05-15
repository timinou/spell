import { afterEach, beforeEach, describe, expect, it, mock, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import {
	generateIntentionSummary,
	parseIntentionSummaryResponse,
	type IntentionSummaryInput,
} from "../../src/utils/intention-summarizer";

const completeSimpleMock = vi.fn();

mock.module("@oh-my-pi/pi-ai", () => ({
	completeSimple: completeSimpleMock,
}));

function getModelOrThrow(id: string) {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected model ${id}`);
	return model;
}

function createSettings(modelRoles: Record<string, string>) {
	return {
		getModelRole(role: string) {
			return modelRoles[role];
		},
		getStorage() {
			return undefined;
		},
	} as never;
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("parseIntentionSummaryResponse", () => {
	it("parses well-formed three-line output (T1)", () => {
		const result = parseIntentionSummaryResponse(
			"DID: Work done\nSTUCK: Blocked on X\nASK: Need your input",
		);
		expect(result).toEqual({ did: "Work done", stuck: "Blocked on X", ask: "Need your input" });
	});

	it("returns undefined stuck when STUCK line is missing (T2)", () => {
		const result = parseIntentionSummaryResponse("DID: Work done\nASK: Need your input");
		expect(result).toEqual({ did: "Work done", ask: "Need your input" });
		expect(result?.stuck).toBeUndefined();
	});

	it("returns undefined stuck when STUCK value is empty (T3)", () => {
		const result = parseIntentionSummaryResponse("DID: Work done\nSTUCK: \nASK: Need your input");
		expect(result).toEqual({ did: "Work done", ask: "Need your input" });
		expect(result?.stuck).toBeUndefined();
	});

	it("handles only DID line (T4)", () => {
		const result = parseIntentionSummaryResponse("DID: Work done");
		expect(result).toEqual({ did: "Work done", ask: "" });
	});

	it("handles only ASK line (T5)", () => {
		const result = parseIntentionSummaryResponse("ASK: Need your input");
		expect(result).toEqual({ did: "", ask: "Need your input" });
	});

	it("returns null when neither DID nor ASK is present (T6)", () => {
		const result = parseIntentionSummaryResponse("STUCK: Blocked\nRandom: line");
		expect(result).toBeNull();
	});

	it("strips trailing period from ASK (T7)", () => {
		const result = parseIntentionSummaryResponse("ASK: Need your input.");
		expect(result).toEqual({ did: "", ask: "Need your input" });
	});

	it("strips wrapping quotes from DID (T8)", () => {
		const result = parseIntentionSummaryResponse('DID: "Work done"');
		expect(result).toEqual({ did: "Work done", ask: "" });
	});
});

describe("generateIntentionSummary", () => {
	it("returns null when no models are available (T9)", async () => {
		const registry = {
			getAvailable: () => [],
			getApiKey: async () => "test-key",
		};
		const settings = createSettings({ smol: "pi/default" });
		const result = await generateIntentionSummary(
			{
				firstUserMessage: "Hello",
				recentAssistantTexts: [],
				inProgressTodoTitles: [],
			} as IntentionSummaryInput,
			registry as never,
			settings,
		);
		expect(result).toBeNull();
	});

	it("returns parsed fields when model responds (T10)", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const settings = createSettings({
			default: `${model.provider}/${model.id}`,
			smol: "pi/default:low",
		});
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
		};
		completeSimpleMock.mockResolvedValue({
			stopReason: "end_turn",
			content: [
				{
					type: "text",
					text: "DID: Refactored auth\nSTUCK: Waiting for approval\nASK: Review the changes",
				},
			],
		} as never);

		const result = await generateIntentionSummary(
			{
				firstUserMessage: "Refactor auth",
				recentAssistantTexts: ["Done"],
				inProgressTodoTitles: ["Update tests"],
				blockingEvent: { kind: "plan_approval", eventId: "e1", title: "Plan" },
			} as IntentionSummaryInput,
			registry as never,
			settings,
		);
		expect(result).toEqual({
			did: "Refactored auth",
			stuck: "Waiting for approval",
			ask: "Review the changes",
		});
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
	});

	it("returns null when signal is pre-aborted (T11)", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const settings = createSettings({ smol: "pi/default" });
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
		};
		const controller = new AbortController();
		controller.abort();

		const result = await generateIntentionSummary(
			{
				firstUserMessage: "Hello",
				recentAssistantTexts: [],
				inProgressTodoTitles: [],
			} as IntentionSummaryInput,
			registry as never,
			settings,
			{ signal: controller.signal },
		);
		expect(result).toBeNull();
		expect(completeSimpleMock).not.toHaveBeenCalled();
	});
});

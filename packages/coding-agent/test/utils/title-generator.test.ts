import { beforeEach, describe, expect, it, mock, vi } from "bun:test";
import { getBundledModel } from "@spell/pi-ai";
import { generateSessionTitle } from "../../src/utils/title-generator";

const completeSimpleMock = vi.fn();

mock.module("@spell/pi-ai", () => ({
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

describe("generateSessionTitle", () => {
	it("disables provider reasoning when smol role is explicitly off", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const settings = createSettings({ smol: `${model.provider}/${model.id}:off` });
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
		};
		completeSimpleMock.mockResolvedValue({
			stopReason: "end_turn",
			content: [{ type: "text", text: "Short title" }],
		} as never);

		const result = await generateSessionTitle("Need a concise title", registry as never, settings);

		expect(result).toBe("Short title");
		expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({
			reasoning: undefined,
			disableReasoning: true,
		});
	});
});

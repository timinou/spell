import { afterEach, describe, expect, test, vi } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import { validatePlanSemantic } from "../../src/orchestrators/fluid/plan-validator";
import type { FluidPlan } from "../../src/orchestrators/fluid/types";
import type { AgentSession } from "../../src/session/agent-session";

const BASIC_PLAN: FluidPlan = {
	agents: [{ id: "analyze", task: "Analyze the request and provide findings.", dependsOn: [] }],
};

function createSession(options?: {
	resolveRoleModel?: AgentSession["resolveRoleModel"];
	model?: AgentSession["model"];
	apiKey?: string;
}): AgentSession {
	const resolveRoleModel =
		options?.resolveRoleModel ?? (() => ({ provider: "anthropic", id: "claude-3-5-haiku-latest" }) as never);
	const model = options?.model;
	const apiKey = options?.apiKey ?? "test-key";

	return {
		resolveRoleModel,
		model,
		sessionId: "session-1",
		modelRegistry: {
			getApiKey: async () => apiKey,
		},
	} as unknown as AgentSession;
}

describe("validatePlanSemantic", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("returns invalid result with critique when validator rejects plan", async () => {
		const completeSimpleSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [
				{ type: "text", text: '{"valid":false,"critique":"Tasks are too vague and dependencies are unclear."}' },
			],
		} as never);

		const result = await validatePlanSemantic(createSession(), BASIC_PLAN, "Fix the flaky CI pipeline");
		expect(result).toEqual({
			valid: false,
			critique: "Tasks are too vague and dependencies are unclear.",
		});
		expect(completeSimpleSpy).toHaveBeenCalledTimes(1);
	});

	test("returns valid result when validator accepts plan", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [{ type: "text", text: '{"valid":true}' }],
		} as never);

		const result = await validatePlanSemantic(createSession(), BASIC_PLAN, "Add structured progress output");
		expect(result).toEqual({ valid: true });
	});

	test("fails open when no model is available", async () => {
		const completeSimpleSpy = vi.spyOn(ai, "completeSimple");

		const result = await validatePlanSemantic(
			createSession({ resolveRoleModel: () => undefined, model: undefined }),
			BASIC_PLAN,
			"Refactor fluid planner",
		);
		expect(result).toEqual({ valid: true });
		expect(completeSimpleSpy).not.toHaveBeenCalled();
	});
});

import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import { PhaseCoordinator } from "../../src/loop/orchestration/phase-coordinator";
import { LlmSwitcher } from "../../src/loop/orchestration/switcher";
import type { LoopSnapshot } from "../../src/loop/types";
import { StubLoopResponder } from "../helpers/stub-llm";

function createLoop(): LoopSnapshot {
	return {
		id: "LOOP-1",
		name: "demo",
		state: "planning",
		iteration: 1,
		maxIterations: 3,
		depth: 0,
		orgItemId: "LOOP-1",
		createdAt: 0,
		updatedAt: 0,
		startedAt: 0,
		currentRole: "plan",
		reflectEvery: 3,
		taskFileHash: "hash",
		changedFiles: [],
		openFindings: [],
		childLoopIds: [],
		requiredChildLoopIds: [],
		pendingChildLoopIds: [],
		pendingGates: [],
		gateConfigs: [],
		gateResults: [],
		checkpoints: [],
		handoffs: [],
		budgetLimits: { wallClockMs: 1000, maxTreeIterations: 10, maxIdleIterations: 5 },
		budgetStatus: { elapsedMs: 0, treeIterations: 0, idleIterations: 0 },
		totalTreeIterations: 0,
		specPaths: [],
		domainNames: [],
		lastProgressHash: "hash",
		autoApproveEnabled: true,
		reviewModelConfigured: true,
	};
}

describe("loop llm orchestration", () => {
	it("runs the plan -> code -> review sequence and creates handoffs", async () => {
		const responder = new StubLoopResponder();
		responder.set("plan", { summary: "iteration plan" });
		responder.set("code", { summary: "implemented", changedFiles: ["src/index.ts"] });
		responder.set("review", { summary: "reviewed", findings: ["missing docs"] });
		const result = await new PhaseCoordinator().runIteration(createLoop(), responder);
		expect(result.handoffs.map(handoff => `${handoff.fromRole}->${handoff.toRole}`)).toEqual([
			"plan->code",
			"code->review",
			"review->plan",
		]);
		expect(result.handoffs[1]?.changedFiles).toEqual(["src/index.ts"]);
		expect(result.findings).toEqual(["missing docs"]);
	});

	it("requires review model configuration before switching to review", () => {
		const switcher = new LlmSwitcher();
		const model = getBundledModel("anthropic", "claude-sonnet-4-6");
		const resolver = {
			getCurrentModel: () => model,
			getPlanModel: () => model,
			getReviewModel: () => undefined,
			getSettings: () => ({ getModelRole: () => undefined }),
		};
		expect(() => switcher.resolve("review", resolver)).toThrow(
			"Loop workflows require the following settings before start: modelRoles.review",
		);
	});

	it("allows review model to equal the planning model", () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-6");
		const resolver = {
			getCurrentModel: () => model,
			getPlanModel: () => model,
			getReviewModel: () => model,
			getSettings: () => ({ getModelRole: () => "anthropic/claude-sonnet-4-6" }),
		};
		const result = new LlmSwitcher().resolve("review", resolver);
		expect(result.model).toBe(model);
	});
});

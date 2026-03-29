import { describe, expect, it } from "bun:test";
import { LOOP_STATES } from "../../src/loop/contracts";
import { GateEvaluator } from "../../src/loop/gates/evaluator";
import type { LoopGateConfig, LoopSnapshot } from "../../src/loop/types";

function createLoop(): LoopSnapshot {
	return {
		id: "LOOP-1",
		name: "demo",
		state: LOOP_STATES.iterating,
		iteration: 3,
		maxIterations: 10,
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

function createGate(id: string, trigger: LoopGateConfig["trigger"], priority = 0): LoopGateConfig {
	return { id, type: "command", trigger, command: "true", priority };
}

describe("GateEvaluator", () => {
	it("fires every-iteration and every-n triggers on matching iterations in priority order", async () => {
		const evaluator = new GateEvaluator({
			executors: {
				command: {
					async execute(gate) {
						return {
							gateId: gate.id,
							trigger: gate.trigger.kind,
							outcome: "pass",
							reason: "ok",
							evidence: [],
							attemptNumber: 1,
							maxAttempts: 1,
						};
					},
				},
			},
		});
		evaluator.register("LOOP-1", createGate("every", { kind: "every-iteration" }, 2));
		evaluator.register("LOOP-1", createGate("every-3", { kind: "every-n", every: 3 }, 1));
		const decisions = await evaluator.evaluate(
			createLoop(),
			{ iteration: 3, state: LOOP_STATES.iterating },
			{ cwd: ".", attemptNumber: 1 },
		);
		expect(decisions.map(decision => decision.gateId)).toEqual(["every-3", "every"]);
	});

	it("fires reflection, completion, and child-complete triggers only in the right contexts", async () => {
		const evaluator = new GateEvaluator({
			executors: {
				command: {
					async execute(gate) {
						return {
							gateId: gate.id,
							trigger: gate.trigger.kind,
							outcome: "pass",
							reason: "ok",
							evidence: [],
							attemptNumber: 1,
							maxAttempts: 1,
						};
					},
				},
			},
		});
		evaluator.register("LOOP-1", createGate("reflection", { kind: "on-reflection" }));
		evaluator.register("LOOP-1", createGate("completion", { kind: "on-completion" }));
		evaluator.register("LOOP-1", createGate("child", { kind: "on-child-complete" }));
		expect(
			(
				await evaluator.evaluate(
					createLoop(),
					{ iteration: 1, state: LOOP_STATES.reflecting },
					{ cwd: ".", attemptNumber: 1 },
				)
			).map(x => x.gateId),
		).toEqual(["reflection"]);
		expect(
			(
				await evaluator.evaluate(
					createLoop(),
					{ iteration: 1, state: LOOP_STATES.validating },
					{ cwd: ".", attemptNumber: 1 },
				)
			).map(x => x.gateId),
		).toEqual(["completion"]);
		expect(
			(
				await evaluator.evaluate(
					createLoop(),
					{
						iteration: 1,
						state: LOOP_STATES.iterating,
						childSignal: {
							childLoopId: "C",
							parentLoopId: "P",
							outcome: "success",
							summary: "ok",
							artifacts: [],
							gateResults: [],
						},
					},
					{ cwd: ".", attemptNumber: 1 },
				)
			).map(x => x.gateId),
		).toEqual(["child"]);
	});

	it("rejects duplicate gate ids and supports unregister", () => {
		const evaluator = new GateEvaluator();
		evaluator.register("LOOP-1", createGate("dup", { kind: "every-iteration" }));
		expect(() => evaluator.register("LOOP-1", createGate("dup", { kind: "every-iteration" }))).toThrow(
			"Duplicate gate id: dup",
		);
		expect(evaluator.unregister("LOOP-1", "dup")).toBe(true);
	});

	it("validates every-n trigger configuration", () => {
		const evaluator = new GateEvaluator();
		expect(() => evaluator.configure("LOOP-1", [createGate("bad", { kind: "every-n", every: 0 })])).toThrow(
			"Gate bad: every-n trigger requires a positive every value",
		);
	});
});

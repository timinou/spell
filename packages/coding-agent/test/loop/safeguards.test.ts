import { describe, expect, it } from "bun:test";
import { checkBudget } from "../../src/loop/safeguards/budget";
import { collectKillTree } from "../../src/loop/safeguards/kill-switch";
import { detectRunaway } from "../../src/loop/safeguards/runaway";
import type { LoopSnapshot } from "../../src/loop/types";

function createLoop(): LoopSnapshot {
	return {
		id: "LOOP-1",
		name: "demo",
		state: "iterating",
		iteration: 5,
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
		childLoopIds: ["LOOP-2"],
		requiredChildLoopIds: ["LOOP-2"],
		pendingChildLoopIds: [],
		pendingGates: [],
		gateConfigs: [],
		gateResults: [],
		checkpoints: [],
		handoffs: [],
		budgetLimits: { wallClockMs: 10, maxTreeIterations: 5, maxIdleIterations: 5 },
		budgetStatus: { elapsedMs: 0, treeIterations: 0, idleIterations: 4 },
		totalTreeIterations: 5,
		specPaths: [],
		domainNames: [],
		lastProgressHash: "hash",
		autoApproveEnabled: true,
		reviewModelConfigured: true,
	};
}

describe("loop safeguards", () => {
	it("flags wall-clock and iteration budget overruns", () => {
		const loop = createLoop();
		expect(checkBudget(loop, 11)).toEqual({ exceeded: true, reason: "Wall-clock budget exceeded (10ms)" });
		loop.startedAt = 100;
		expect(checkBudget(loop, 100)).toEqual({ exceeded: true, reason: "Iteration budget exceeded (5)" });
	});

	it("detects runaway iterations when progress does not change", () => {
		const loop = createLoop();
		const runaway = detectRunaway(loop, "hash");
		expect(runaway.runaway).toBe(true);
		expect(detectRunaway(loop, "new-hash")).toEqual({ runaway: false, idleIterations: 0 });
	});

	it("collects kill-switch ids for a whole loop tree", () => {
		const parent = createLoop();
		const child = { ...createLoop(), id: "LOOP-2", parentLoopId: "LOOP-1", childLoopIds: ["LOOP-3"] };
		const grandchild = { ...createLoop(), id: "LOOP-3", parentLoopId: "LOOP-2", childLoopIds: [] };
		expect(collectKillTree("LOOP-1", [parent, child, grandchild])).toEqual(["LOOP-1", "LOOP-2", "LOOP-3"]);
	});
});

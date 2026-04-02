import { describe, expect, it } from "bun:test";
import type { ChildCompletionSignal } from "../../src/loop/contracts";
import { applyChildCompletionPolicy } from "../../src/loop/recursion/completion-handler";
import { LoopDag } from "../../src/loop/recursion/dag";
import { ChildSpawner } from "../../src/loop/recursion/spawner";
import type { LoopSnapshot } from "../../src/loop/types";

function createParent(depth = 0): LoopSnapshot {
	return {
		id: `LOOP-${depth}`,
		name: "parent",
		state: "iterating",
		iteration: 0,
		maxIterations: 3,
		depth,
		orgItemId: `LOOP-${depth}`,
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
		gitAvailable: true,
	};
}

describe("loop recursion", () => {
	it("spawns children until the depth limit and then escalates", () => {
		const dag = new LoopDag();
		const spawner = new ChildSpawner(dag, 4);
		const allowed = spawner.prepareChild(createParent(3), { name: "child", id: "LOOP-4" });
		expect(allowed.allowed).toBe(true);
		const denied = spawner.prepareChild(createParent(4), { name: "child", id: "LOOP-5" });
		expect(denied.allowed).toBe(false);
		expect(denied.escalate).toBe(true);
	});

	it("detects cycles and produces topological order", () => {
		const dag = new LoopDag();
		dag.addEdge("A", "B", true, { policy: "retry", retries: 2 });
		dag.addEdge("B", "C", true, { policy: "retry", retries: 2 });
		expect(() => dag.addEdge("C", "A", true, { policy: "retry", retries: 2 })).toThrow("Loop DAG cycle rejected");
		expect(dag.topologicalOrder("A")).toEqual(["A", "B", "C"]);
	});

	it("applies retry, block, skip, and escalate child completion policies", () => {
		const signal: ChildCompletionSignal = {
			childLoopId: "C",
			parentLoopId: "P",
			outcome: "failed",
			summary: "bad",
			artifacts: [],
			gateResults: [],
		};
		expect(applyChildCompletionPolicy(signal, { policy: "retry", retries: 2 }, 0).action).toBe("retry");
		expect(applyChildCompletionPolicy(signal, { policy: "retry", retries: 1 }, 1).action).toBe("block");
		expect(applyChildCompletionPolicy(signal, { policy: "skip" }, 0).action).toBe("skip");
		expect(applyChildCompletionPolicy(signal, { policy: "escalate" }, 0).action).toBe("escalate");
	});
});

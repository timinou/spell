import { describe, expect, test } from "bun:test";

import { SwarmScheduler } from "../../src/task/swarm-scheduler";

interface NodeLike {
	kind?: "work" | "data";
	status?: "pending" | "in_progress" | "completed" | "failed" | "aborted" | "gate_failed" | "abandoned";
	filesDeps?: string[];
	dataContent?: string;
	artifactPath?: string;
}

function node(partial: Partial<NodeLike> = {}): NodeLike {
	return { kind: "work", status: "pending", ...partial };
}

describe("SwarmScheduler", () => {
	test("pumps a static DAG in topological order", async () => {
		const scheduler = new SwarmScheduler<NodeLike>([
			["A", node()],
			["B", node(), ["A"]],
			["C", node(), ["A"]],
			["D", node(), ["B", "C"]],
		]);
		const started: string[] = [];
		await scheduler.pump(async id => {
			started.push(id);
			scheduler.markCompleted(id);
		});
		expect(started).toEqual(["A", "B", "C", "D"]);
	});

	test("supports multi-entry readiness and dynamic node mutation", () => {
		const scheduler = new SwarmScheduler<NodeLike>([
			["A", node()],
			["B", node()],
			["C", node(), ["A", "B"]],
		]);
		expect(scheduler.getReadyNodeIds()).toEqual(["A", "B"]);
		scheduler.markCompleted("A");
		expect(scheduler.getReadyNodeIds()).toEqual(["B"]);
		scheduler.addNode("D", node(), ["B"]);
		scheduler.markCompleted("B");
		expect(scheduler.getReadyNodeIds()).toEqual(["C", "D"]);
		scheduler.removeNode("D");
		expect(scheduler.dag.hasNode("D")).toBe(false);
	});

	test("supports live add-node during an active pump", async () => {
		const gate = Promise.withResolvers<void>();
		const scheduler = new SwarmScheduler<NodeLike>([["A", node()]]);
		const started: string[] = [];
		const pump = scheduler.pump(async id => {
			started.push(id);
			if (id === "A") {
				scheduler.addNode("B", node(), ["A"]);
				await gate.promise;
			}
			scheduler.markCompleted(id);
		});
		await Bun.sleep(10);
		expect(started).toEqual(["A"]);
		expect(scheduler.dag.hasNode("B")).toBe(true);
		gate.resolve();
		await pump;
		expect(started).toEqual(["A", "B"]);
		expect(scheduler.dag.getNode("B")?.status).toBe("completed");
	});

	test("supports live remove-node cascade during an active pump", async () => {
		const gate = Promise.withResolvers<void>();
		const scheduler = new SwarmScheduler<NodeLike>([
			["A", node()],
			["B", node(), ["A"]],
			["C", node(), ["B"]],
		]);
		const started: string[] = [];
		const pump = scheduler.pump(async id => {
			started.push(id);
			if (id === "A") {
				scheduler.removeNode("B");
				await gate.promise;
			}
			scheduler.markCompleted(id);
		});
		await Bun.sleep(10);
		expect(started).toEqual(["A"]);
		expect(scheduler.dag.hasNode("B")).toBe(false);
		expect(scheduler.dag.hasNode("C")).toBe(false);
		gate.resolve();
		await pump;
		expect(started).toEqual(["A"]);
		expect(scheduler.dag.hasNode("B")).toBe(false);
		expect(scheduler.dag.hasNode("C")).toBe(false);
	});

	test("treats satisfied data nodes as ready and cascades failure", () => {
		const scheduler = new SwarmScheduler<NodeLike>([
			["data", node({ kind: "data", artifactPath: "artifact://x" })],
			["task", node(), ["data"]],
			["downstream", node(), ["task"]],
		]);
		expect(scheduler.getReadyNodeIds()).toEqual(["task"]);
		scheduler.markFailed("task");
		expect(scheduler.dag.getNode("downstream")?.status).toBe("failed");
	});

	test("propagates multi-level failure cascades", async () => {
		const gate = Promise.withResolvers<void>();
		const scheduler = new SwarmScheduler<NodeLike>([
			["A", node()],
			["B", node(), ["A"]],
			["C", node(), ["B"]],
		]);
		const started: string[] = [];
		const pump = scheduler.pump(async id => {
			started.push(id);
			if (id === "A") {
				await gate.promise;
				throw new Error("A failed");
			}
			scheduler.markCompleted(id);
		});
		await Bun.sleep(10);
		expect(started).toEqual(["A"]);
		gate.resolve();
		await pump;
		expect(started).toEqual(["A"]);
		expect(scheduler.dag.getNode("A")?.status).toBe("failed");
		expect(scheduler.dag.getNode("B")?.status).toBe("failed");
		expect(scheduler.dag.getNode("C")?.status).toBe("failed");
	});

	test("serializes overlapping files under isolation", async () => {
		const scheduler = new SwarmScheduler<NodeLike>(
			[
				["A", node({ filesDeps: ["one.ts"] })],
				["B", node({ filesDeps: ["one.ts"] })],
			],
			{ maxConcurrency: 2, isolationMode: true },
		);
		const started: string[] = [];
		await scheduler.pump(async id => {
			started.push(id);
			scheduler.markCompleted(id);
		});
		expect(started).toEqual(["A", "B"]);
	});

	test("does not parallelize opaque work under isolation when filesDeps are missing", async () => {
		const gate = Promise.withResolvers<void>();
		const scheduler = new SwarmScheduler<NodeLike>(
			[
				["A", node()],
				["B", node({ filesDeps: ["two.ts"] })],
			],
			{ maxConcurrency: 2, isolationMode: true },
		);
		const started: string[] = [];
		const pump = scheduler.pump(async id => {
			started.push(id);
			if (id === "A") {
				await gate.promise;
			}
			scheduler.markCompleted(id);
		});
		await Bun.sleep(10);
		expect(started).toEqual(["A"]);
		gate.resolve();
		await pump;
		expect(started).toEqual(["A", "B"]);
	});

	test("aborts pending work", async () => {
		const controller = new AbortController();
		const scheduler = new SwarmScheduler<NodeLike>([
			["A", node()],
			["B", node(), ["A"]],
		]);
		controller.abort();
		const result = await scheduler.pump(async () => undefined, controller.signal);
		expect(result.aborted.length).toBeGreaterThan(0);
	});
});

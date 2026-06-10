import { describe, expect, test } from "bun:test";

import { createSpawnSuccessorTool } from "../../src/swarm/spawn-successor-tool";
import { SwarmScheduler } from "../../src/task/swarm-scheduler";

function makeScheduler() {
	return new SwarmScheduler([["task://sess-1/main/task-3", { kind: "work", status: "pending" }, []]], {
		maxConcurrency: 1,
	});
}

describe("spawn_successor tool", () => {
	test("spawns a successor node and returns its URI", async () => {
		const scheduler = makeScheduler();
		const tool = createSpawnSuccessorTool({
			active: true,
			agent: "main",
			sessionId: "sess-1",
			currentTaskUri: "task://sess-1/main/task-3",
			scheduler,
		});

		const result = await tool.execute("call-1", { slug: "task-4" }, undefined, {} as never);
		const first = result.content[0];

		expect(first?.type).toBe("text");
		expect(first && first.type === "text" ? first.text : "").toBe("task://sess-1/main/task-4");
		expect(scheduler.dag.hasNode("task://sess-1/main/task-4")).toBe(true);
		expect(scheduler.dag.getDependencies("task://sess-1/main/task-4")).toEqual(["task://sess-1/main/task-3"]);
	});

	test("uses explicit empty deps for an immediate start", async () => {
		const scheduler = makeScheduler();
		const tool = createSpawnSuccessorTool({
			active: true,
			agent: "main",
			sessionId: "sess-1",
			currentTaskUri: "task://sess-1/main/task-3",
			scheduler,
		});

		await tool.execute("call-2", { slug: "task-5", deps: [] }, undefined, {} as never);
		expect(scheduler.dag.getDependencies("task://sess-1/main/task-5")).toEqual([]);
	});

	test("rejects missing dependencies and non-swarm use", async () => {
		const scheduler = makeScheduler();
		const tool = createSpawnSuccessorTool({
			active: true,
			agent: "main",
			sessionId: "sess-1",
			currentTaskUri: "task://sess-1/main/task-3",
			scheduler,
		});

		await expect(
			tool.execute("call-3", { slug: "task-6", deps: ["task://sess-1/main/missing"] }, undefined, {} as never),
		).rejects.toThrow("MutableDag missing dependency: task://sess-1/main/missing");

		const inactiveTool = createSpawnSuccessorTool({
			active: false,
			agent: "main",
			sessionId: "sess-1",
			currentTaskUri: "task://sess-1/main/task-3",
			scheduler,
		});
		await expect(inactiveTool.execute("call-4", { slug: "task-7" }, undefined, {} as never)).rejects.toThrow(
			"spawn_successor tool is only available in swarm mode",
		);
	});

	test("rejects cycle-causing successor reuse", async () => {
		const scheduler = makeScheduler();
		const tool = createSpawnSuccessorTool({
			active: true,
			agent: "main",
			sessionId: "sess-1",
			currentTaskUri: "task://sess-1/main/task-3",
			scheduler,
		});

		await expect(tool.execute("call-5", { slug: "task-3" }, undefined, {} as never)).rejects.toThrow(
			/duplicate node|cycle/i,
		);
	});
});

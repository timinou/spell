import { describe, expect, test } from "bun:test";

import { promoteReadyNodes, type TodoDelegation, type TodoNode } from "../../src/tools/todo-write";

function delegated(sessionId: string): TodoDelegation {
	return { sessionId, agent: "task" };
}

describe("promoteReadyNodes", () => {
	test("starts a single direct task when isolation mode is off", () => {
		const nodes: TodoNode[] = [
			{ id: "task-1", content: "A", status: "pending", group: "Execution" },
			{ id: "task-2", content: "B", status: "pending", group: "Execution", blockers: ["task-1"] },
		];

		promoteReadyNodes(nodes, false);
		expect(nodes.map(task => task.status)).toEqual(["in_progress", "pending"]);
	});

	test("starts independent file-scoped tasks together when isolation mode is on", () => {
		const nodes: TodoNode[] = [
			{ id: "task-1", content: "A", status: "pending", group: "Execution", filesDeps: ["src/a.ts"] },
			{ id: "task-2", content: "B", status: "pending", group: "Execution", filesDeps: ["src/b.ts"] },
		];

		promoteReadyNodes(nodes, true);
		expect(nodes.map(task => task.status)).toEqual(["in_progress", "in_progress"]);
	});

	test("serializes overlapping file work even when isolation mode is on", () => {
		const nodes: TodoNode[] = [
			{ id: "task-1", content: "A", status: "pending", group: "Execution", filesDeps: ["src/shared.ts"] },
			{ id: "task-2", content: "B", status: "pending", group: "Execution", filesDeps: ["src/shared.ts"] },
		];

		promoteReadyNodes(nodes, true);
		expect(nodes.map(task => task.status)).toEqual(["in_progress", "pending"]);
	});

	test("ignores delegated in-progress work for direct-task promotion", () => {
		const nodes: TodoNode[] = [
			{ id: "task-1", content: "delegated", status: "in_progress", group: "Execution", delegation: delegated("child-1") },
			{ id: "task-2", content: "direct", status: "pending", group: "Execution" },
		];

		promoteReadyNodes(nodes, false);
		expect(nodes.map(task => task.status)).toEqual(["in_progress", "in_progress"]);
	});

	test("promotes a task once its blocker is completed", () => {
		const nodes: TodoNode[] = [
			{ id: "task-1", content: "done", status: "completed", group: "Execution" },
			{ id: "task-2", content: "ready", status: "pending", group: "Execution", blockers: ["task-1"] },
		];

		promoteReadyNodes(nodes, false);
		expect(nodes.map(task => task.status)).toEqual(["completed", "in_progress"]);
	});

	test("auto-satisfies a data node with content and unblocks dependent work", () => {
		const nodes: TodoNode[] = [
			{ id: "contract", kind: "data", content: "API contract", dataContent: "{}", status: "pending", group: "Execution" },
			{ id: "implement", content: "Implement API", status: "pending", group: "Execution", blockers: ["contract"] },
		];

		promoteReadyNodes(nodes, false);
		expect(nodes.map(task => task.status)).toEqual(["completed", "in_progress"]);
	});
});

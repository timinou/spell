import { describe, expect, test } from "bun:test";

import { promoteReadyTasks, type TodoDelegation, type TodoGroup } from "../../src/tools/todo-write";

function delegated(sessionId: string): TodoDelegation {
	return { sessionId, agent: "task" };
}

describe("promoteReadyTasks", () => {
	test("starts a single direct task when isolation mode is off", () => {
		const groups: TodoGroup[] = [
			{
				id: "phase-1",
				name: "Execution",
				tasks: [
					{ id: "task-1", content: "A", status: "pending" },
					{ id: "task-2", content: "B", status: "pending", blockers: ["task-1"] },
				],
			},
		];

		promoteReadyTasks(groups, false);
		expect(groups[0]?.tasks.map(task => task.status)).toEqual(["in_progress", "pending"]);
	});

	test("starts independent file-scoped tasks together when isolation mode is on", () => {
		const groups: TodoGroup[] = [
			{
				id: "phase-1",
				name: "Execution",
				tasks: [
					{ id: "task-1", content: "A", status: "pending", filesDeps: ["src/a.ts"] },
					{ id: "task-2", content: "B", status: "pending", filesDeps: ["src/b.ts"] },
				],
			},
		];

		promoteReadyTasks(groups, true);
		expect(groups[0]?.tasks.map(task => task.status)).toEqual(["in_progress", "in_progress"]);
	});

	test("serializes overlapping file work even when isolation mode is on", () => {
		const groups: TodoGroup[] = [
			{
				id: "phase-1",
				name: "Execution",
				tasks: [
					{ id: "task-1", content: "A", status: "pending", filesDeps: ["src/shared.ts"] },
					{ id: "task-2", content: "B", status: "pending", filesDeps: ["src/shared.ts"] },
				],
			},
		];

		promoteReadyTasks(groups, true);
		expect(groups[0]?.tasks.map(task => task.status)).toEqual(["in_progress", "pending"]);
	});

	test("ignores delegated in-progress work for direct-task promotion", () => {
		const groups: TodoGroup[] = [
			{
				id: "phase-1",
				name: "Execution",
				tasks: [
					{ id: "task-1", content: "delegated", status: "in_progress", delegation: delegated("child-1") },
					{ id: "task-2", content: "direct", status: "pending" },
				],
			},
		];

		promoteReadyTasks(groups, false);
		expect(groups[0]?.tasks.map(task => task.status)).toEqual(["in_progress", "in_progress"]);
	});

	test("promotes a task once its blocker is completed", () => {
		const groups: TodoGroup[] = [
			{
				id: "phase-1",
				name: "Execution",
				tasks: [
					{ id: "task-1", content: "done", status: "completed" },
					{ id: "task-2", content: "ready", status: "pending", blockers: ["task-1"] },
				],
			},
		];

		promoteReadyTasks(groups, false);
		expect(groups[0]?.tasks.map(task => task.status)).toEqual(["completed", "in_progress"]);
	});

	test("auto-satisfies a data node with content and unblocks dependent work", () => {
		const groups: TodoGroup[] = [
			{
				id: "phase-1",
				name: "Execution",
				tasks: [
					{ id: "contract", kind: "data", content: "API contract", dataContent: "{}", status: "pending" },
					{ id: "implement", content: "Implement API", status: "pending", blockers: ["contract"] },
				],
			},
		];

		promoteReadyTasks(groups, false);
		expect(groups[0]?.tasks.map(task => task.status)).toEqual(["completed", "in_progress"]);
	});
});

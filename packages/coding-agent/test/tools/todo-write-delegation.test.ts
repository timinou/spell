import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "../../src/tools";
import type { FormatSummaryOptions, TodoDelegation, TodoGroup, TodoItem, TodoStatus } from "../../src/tools/todo-write";
import { cloneTodoGroups, formatSummary, TodoWriteTool } from "../../src/tools/todo-write";

function createSession(initialGroups: TodoGroup[] = []): ToolSession {
	let groups = initialGroups;
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getTodoGroups: () => groups,
		setTodoGroups: next => {
			groups = next;
		},
	};
}

function makeDelegation(overrides: Partial<TodoDelegation> = {}): TodoDelegation {
	return {
		sessionId: "subagent-session-1",
		transcriptPath: "/tmp/subagent-session-1.jsonl",
		agent: "task",
		...overrides,
	};
}

function makeTask(overrides: Partial<TodoItem> & { id: string; content: string }): TodoItem {
	return {
		status: "pending" as TodoStatus,
		...overrides,
	};
}

function makePhase(id: string, name: string, tasks: TodoItem[]): TodoGroup {
	return { id, name, tasks };
}

function callFormatSummary(overrides: Partial<FormatSummaryOptions> = {}): string {
	return formatSummary({
		groups: overrides.groups ?? [makePhase("phase-1", "Work", [makeTask({ id: "task-1", content: "Do thing" })])],
		errors: overrides.errors ?? [],
		completedGroupIds: overrides.completedGroupIds ?? [],
		completedGatedTasks: overrides.completedGatedTasks ?? [],
		pendingVerificationTasks: overrides.pendingVerificationTasks ?? [],
		pendingDeferralTasks: overrides.pendingDeferralTasks ?? [],
	});
}

describe("Todo delegation model", () => {
	test("cloneTodoGroups deep-clones delegation metadata", () => {
		const original = [
			makePhase("phase-1", "Work", [
				makeTask({
					id: "task-1",
					content: "Delegate review",
					status: "in_progress",
					delegation: makeDelegation({
						result: {
							verification: {
								status: "failed",
								failures: [{ gate: "gateCmd", expected: "bun test", detail: "missing", taskId: "child-1" }],
							},
						},
					}),
				}),
			]),
		];

		const cloned = cloneTodoGroups(original);
		cloned[0].tasks[0].delegation!.sessionId = "subagent-session-2";
		cloned[0].tasks[0].delegation!.result!.verification!.failures![0]!.detail = "updated";

		expect(original[0].tasks[0].delegation?.sessionId).toBe("subagent-session-1");
		expect(cloned[0].tasks[0].delegation?.sessionId).toBe("subagent-session-2");
		expect(original[0].tasks[0].delegation?.result?.verification?.failures?.[0]?.detail).toBe("missing");
	});

	test("normalization keeps delegated work running while demoting extra direct in_progress tasks", async () => {
		const tool = new TodoWriteTool(
			createSession([
				makePhase("phase-1", "Work", [
					makeTask({ id: "task-1", content: "Direct task", status: "in_progress" }),
					makeTask({
						id: "task-2",
						content: "Delegated task",
						status: "in_progress",
						delegation: makeDelegation(),
					}),
					makeTask({ id: "task-3", content: "Second direct task", status: "in_progress" }),
				]),
			]),
		);

		const result = await tool.execute("call-1", {
			ops: [{ op: "update", id: "task-1", notes: "keep current direct work" }],
		});

		const tasks = result.details?.groups[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["in_progress", "in_progress", "pending"]);
		expect(tasks[1]?.delegation?.sessionId).toBe("subagent-session-1");
	});

	test("normalization auto-promotes one direct task even when delegated work is already running", async () => {
		const tool = new TodoWriteTool(
			createSession([
				makePhase("phase-1", "Work", [
					makeTask({ id: "task-1", content: "Direct follow-up", status: "pending" }),
					makeTask({
						id: "task-2",
						content: "Delegated child",
						status: "in_progress",
						delegation: makeDelegation(),
					}),
				]),
			]),
		);

		const result = await tool.execute("call-1", {
			ops: [{ op: "update", id: "task-2", notes: "subagent still running" }],
		});

		const tasks = result.details?.groups[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["in_progress", "in_progress"]);
		expect(tasks[0]?.delegation).toBeUndefined();
		expect(tasks[1]?.delegation?.sessionId).toBe("subagent-session-1");
	});

	test("formatSummary labels delegated tasks for operator visibility", () => {
		const delegated = makeTask({
			id: "task-2",
			content: "Review child output",
			status: "in_progress",
			delegation: makeDelegation(),
		});
		const result = callFormatSummary({
			groups: [makePhase("phase-1", "Work", [makeTask({ id: "task-1", content: "Direct task" }), delegated])],
		});

		expect(result).toContain("Review child output [delegated]");
	});
});

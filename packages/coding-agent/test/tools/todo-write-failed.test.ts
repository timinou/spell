import { describe, expect, test } from "bun:test";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import type { ToolSession } from "../../src/tools";
import type { FormatSummaryOptions, TodoGroup, TodoItem, TodoStatus } from "../../src/tools/todo-write";
import { formatSummary, TodoWriteTool } from "../../src/tools/todo-write";

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
	} as ToolSession;
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

describe("TodoWriteTool failed status", () => {
	test("failed task is accepted and prevents auto-promotion of later direct work", async () => {
		const tool = new TodoWriteTool(
			createSession([
				makePhase("phase-1", "Work", [
					makeTask({ id: "task-1", content: "Delegated work", status: "failed" }),
					makeTask({ id: "task-2", content: "Follow-up", status: "pending" }),
				]),
			]),
		);

		const result = await tool.execute("call-1", {
			ops: [{ op: "update", id: "task-1", notes: "subagent failed" }],
		});

		const tasks = result.details?.groups[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["failed", "in_progress"]);
	});

	test("formatSummary keeps failed tasks visible to the operator", () => {
		const result = callFormatSummary({
			groups: [
				makePhase("phase-1", "Work", [makeTask({ id: "task-1", content: "Delegated work", status: "failed" })]),
			],
		});

		expect(result).toContain("task-1 Delegated work [failed] (Work)");
		expect(result).toContain('Group 1/1 "Work"');
	});
});

import { describe, expect, test } from "bun:test";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import type { ToolSession } from "../../src/tools";
import type { FormatSummaryOptions, TodoNode, TodoStatus } from "../../src/tools/todo-write";
import { formatSummary, TodoWriteTool } from "../../src/tools/todo-write";

function createSession(initialNodes: TodoNode[] = []): ToolSession {
	let nodes = initialNodes;
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getTodoNodes: () => nodes,
		setTodoNodes: (next: TodoNode[]) => {
			nodes = next;
		},
	} as ToolSession;
}

function makeTask(overrides: Partial<TodoNode> & { id: string; content: string }): TodoNode {
	return {
		status: "pending" as TodoStatus,
		...overrides,
	};
}

function callFormatSummary(overrides: Partial<FormatSummaryOptions> = {}): string {
	return formatSummary({
		nodes: overrides.nodes ?? [makeTask({ id: "task-1", content: "Do thing", group: "Work" })],
		errors: overrides.errors ?? [],
		warnings: overrides.warnings ?? [],
		completedGroups: overrides.completedGroups ?? [],
		completedGatedNodes: overrides.completedGatedNodes ?? [],
		pendingVerificationNodes: overrides.pendingVerificationNodes ?? [],
		gateVerificationFailures: overrides.gateVerificationFailures ?? [],
		pendingDeferralNodes: overrides.pendingDeferralNodes ?? [],
	});
}

describe("TodoWriteTool failed status", () => {
	test("failed task is accepted and prevents auto-promotion of later direct work", async () => {
		const tool = new TodoWriteTool(
			createSession([
				makeTask({ id: "task-1", content: "Delegated work", status: "failed", group: "Work" }),
				makeTask({ id: "task-2", content: "Follow-up", status: "pending", group: "Work" }),
			]),
		);

		const result = await tool.execute("call-1", {
			tasks: [{ id: "task-1", notes: "subagent failed" }],
		});

		const tasks = result.details?.nodes ?? [];
		expect(tasks.map(task => task.status)).toEqual(["failed", "in_progress"]);
	});

	test("formatSummary keeps failed tasks visible to the operator", () => {
		const result = callFormatSummary({
			nodes: [
				makeTask({ id: "task-1", content: "Delegated work", status: "failed", group: "Work" }),
			],
		});

		expect(result).toContain("task-1 Delegated work [failed] (Work)");
		expect(result).toContain("Progress: 0/1 complete.");
	});
});

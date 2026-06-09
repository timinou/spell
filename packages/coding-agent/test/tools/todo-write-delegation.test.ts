import { describe, expect, test } from "bun:test";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import type { ToolSession } from "../../src/tools";
import type { FormatSummaryOptions, TodoDelegation, TodoNode, TodoStatus } from "../../src/tools/todo-write";
import { cloneTodoNodes, formatSummary, TodoWriteTool } from "../../src/tools/todo-write";

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
	} as unknown as ToolSession;
}

function makeDelegation(overrides: Partial<TodoDelegation> = {}): TodoDelegation {
	return {
		sessionId: "subagent-session-1",
		transcriptPath: "/tmp/subagent-session-1.jsonl",
		agent: "task",
		...overrides,
	};
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

describe("Todo delegation model", () => {
	test("cloneTodoNodes deep-clones delegation metadata", () => {
		const original: TodoNode[] = [
			makeTask({
				id: "task-1",
				content: "Delegate review",
				status: "in_progress",
				group: "Work",
				delegation: makeDelegation({
					result: {
						verification: {
							status: "failed",
							failures: [{ gate: "gateCmd", expected: "bun test", detail: "missing", taskId: "child-1" }],
						},
					},
				}),
			}),
		];

		const cloned = cloneTodoNodes(original);
		cloned[0].delegation!.sessionId = "subagent-session-2";
		cloned[0].delegation!.result!.verification!.failures![0]!.detail = "updated";

		expect(original[0].delegation?.sessionId).toBe("subagent-session-1");
		expect(cloned[0].delegation?.sessionId).toBe("subagent-session-2");
		expect(original[0].delegation?.result?.verification?.failures?.[0]?.detail).toBe("missing");
	});

	test("normalization keeps delegated work running while demoting extra direct in_progress tasks", async () => {
		const tool = new TodoWriteTool(
			createSession([
				makeTask({ id: "task-1", content: "Direct task", status: "in_progress" }),
				makeTask({
					id: "task-2",
					content: "Delegated task",
					status: "in_progress",
					delegation: makeDelegation(),
				}),
				makeTask({ id: "task-3", content: "Second direct task", status: "in_progress" }),
			]),
		);

		const result = await tool.execute("call-1", {
			tasks: [{ id: "task-1", notes: "keep current direct work" }],
		});

		const tasks = result.details?.nodes ?? [];
		expect(tasks.map(task => task.status)).toEqual(["in_progress", "in_progress", "pending"]);
		expect(tasks[1]?.delegation?.sessionId).toBe("subagent-session-1");
	});

	test("normalization auto-promotes one direct task even when delegated work is already running", async () => {
		const tool = new TodoWriteTool(
			createSession([
				makeTask({ id: "task-1", content: "Direct follow-up", status: "pending" }),
				makeTask({
					id: "task-2",
					content: "Delegated child",
					status: "in_progress",
					delegation: makeDelegation(),
				}),
			]),
		);

		const result = await tool.execute("call-1", {
			tasks: [{ id: "task-2", notes: "subagent still running" }],
		});

		const tasks = result.details?.nodes ?? [];
		expect(tasks.map(task => task.status)).toEqual(["in_progress", "in_progress"]);
		expect(tasks[0]?.delegation).toBeUndefined();
		expect(tasks[1]?.delegation?.sessionId).toBe("subagent-session-1");
	});

	test("formatSummary labels delegated tasks for operator visibility", () => {
		const delegated = makeTask({
			id: "task-2",
			content: "Review child output",
			status: "in_progress",
			group: "Work",
			delegation: makeDelegation(),
		});
		const result = callFormatSummary({
			nodes: [makeTask({ id: "task-1", content: "Direct task", group: "Work" }), delegated],
		});

		expect(result).toContain("Review child output [delegated]");
	});
});

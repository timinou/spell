import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TodoWriteTool } from "@oh-my-pi/pi-coding-agent/tools";
import type { FormatSummaryOptions, TodoDelegation, TodoItem, TodoPhase, TodoStatus } from "../../src/tools/todo-write";
import { cloneTodoPhases, formatSummary } from "../../src/tools/todo-write";

function createSession(initialPhases: TodoPhase[] = []): ToolSession {
	let phases = initialPhases;
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getTodoPhases: () => phases,
		setTodoPhases: next => {
			phases = next;
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

function makePhase(id: string, name: string, tasks: TodoItem[]): TodoPhase {
	return { id, name, tasks };
}

function callFormatSummary(overrides: Partial<FormatSummaryOptions> = {}): string {
	return formatSummary({
		phases: overrides.phases ?? [makePhase("phase-1", "Work", [makeTask({ id: "task-1", content: "Do thing" })])],
		errors: overrides.errors ?? [],
		completedPhaseIds: overrides.completedPhaseIds ?? [],
		completedGatedTasks: overrides.completedGatedTasks ?? [],
		pendingVerificationTasks: overrides.pendingVerificationTasks ?? [],
		pendingDeferralTasks: overrides.pendingDeferralTasks ?? [],
	});
}

describe("Todo delegation model", () => {
	test("cloneTodoPhases deep-clones delegation metadata", () => {
		const original = [
			makePhase("phase-1", "Work", [
				makeTask({
					id: "task-1",
					content: "Delegate review",
					status: "in_progress",
					delegation: makeDelegation(),
				}),
			]),
		];

		const cloned = cloneTodoPhases(original);
		cloned[0].tasks[0].delegation!.sessionId = "subagent-session-2";

		expect(original[0].tasks[0].delegation?.sessionId).toBe("subagent-session-1");
		expect(cloned[0].tasks[0].delegation?.sessionId).toBe("subagent-session-2");
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

		const tasks = result.details?.phases[0]?.tasks ?? [];
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

		const tasks = result.details?.phases[0]?.tasks ?? [];
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
			phases: [makePhase("phase-1", "Work", [makeTask({ id: "task-1", content: "Direct task" }), delegated])],
		});

		expect(result).toContain("Review child output [delegated]");
	});
});

/**
 * Tests for deferral gate enforcement on todo_write.
 *
 * Contracts:
 *   - Abandonment without deferralFupId is rejected; task stays unchanged
 *   - Empty/whitespace-only deferralFupId treated as missing
 *   - Valid deferralFupId allows abandonment and is stored on the task
 *   - Batch ops: valid items succeed even when others are rejected
 *   - formatSummary shows "Deferral Required" with org create template
 *   - Template includes orgItemId / orgItemClosingId context when present
 *   - Phase completion warns about deferred tasks with FUP IDs
 *   - Replace/add_phase always create tasks as pending
 *   - Abandoned tasks survive (not auto-cleared)
 */

import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "../../src/tools";
import type { FormatSummaryOptions, TodoGroup, TodoItem, TodoStatus } from "../../src/tools/todo-write";
import { formatSummary, TodoWriteTool } from "../../src/tools/todo-write";

// =============================================================================
// Helpers
// =============================================================================

function makeTask(overrides: Partial<TodoItem> & { id: string; content: string }): TodoItem {
	return { status: "pending" as TodoStatus, ...overrides };
}

function makePhase(id: string, name: string, tasks: TodoItem[]): TodoGroup {
	return { id, name, tasks };
}

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

/** Extract text summary from tool result. */
function summaryText(result: { content: Array<{ type: string; text?: string }> }): string {
	const part = result.content.find(p => p.type === "text");
	if (!part || part.type !== "text") throw new Error("Expected text summary from todo_write");
	return part.text!;
}

// =============================================================================
// Deferral gate enforcement (via TodoWriteTool.execute)
// =============================================================================

describe("deferral gate enforcement", () => {
	test("rejects abandonment without deferralFupId", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("c1", {
			ops: [{ op: "replace", groups: [{ name: "Work", tasks: [{ content: "Build it" }] }] }],
		});

		const result = await tool.execute("c2", {
			ops: [{ op: "update", id: "task-1", status: "abandoned" }],
		});

		const tasks = result.details?.groups[0]?.tasks ?? [];
		expect(tasks[0].status).not.toBe("abandoned");
		const text = summaryText(result);
		expect(text).toContain("Deferral Required");
		expect(text).toContain("org create");
	});

	test("rejects abandonment with empty string deferralFupId", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("c1", {
			ops: [{ op: "replace", groups: [{ name: "Work", tasks: [{ content: "Build it" }] }] }],
		});

		const result = await tool.execute("c2", {
			ops: [{ op: "update", id: "task-1", status: "abandoned", deferralFupId: "" }],
		});

		const tasks = result.details?.groups[0]?.tasks ?? [];
		expect(tasks[0].status).not.toBe("abandoned");
		expect(summaryText(result)).toContain("Deferral Required");
	});

	test("rejects abandonment with whitespace-only deferralFupId", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("c1", {
			ops: [{ op: "replace", groups: [{ name: "Work", tasks: [{ content: "Build it" }] }] }],
		});

		const result = await tool.execute("c2", {
			ops: [{ op: "update", id: "task-1", status: "abandoned", deferralFupId: "   " }],
		});

		const tasks = result.details?.groups[0]?.tasks ?? [];
		expect(tasks[0].status).not.toBe("abandoned");
		expect(summaryText(result)).toContain("Deferral Required");
	});

	test("accepts abandonment with valid deferralFupId", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("c1", {
			ops: [{ op: "replace", groups: [{ name: "Work", tasks: [{ content: "Build it" }] }] }],
		});

		const result = await tool.execute("c2", {
			ops: [{ op: "update", id: "task-1", status: "abandoned", deferralFupId: "FUP-008-handle-retries" }],
		});

		const tasks = result.details?.groups[0]?.tasks ?? [];
		expect(tasks[0].status).toBe("abandoned");
		expect(tasks[0].deferralFupId).toBe("FUP-008-handle-retries");
		expect(summaryText(result)).not.toContain("Deferral Required");
	});

	test("stores deferralFupId on task in result phases", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("c1", {
			ops: [{ op: "replace", groups: [{ name: "Work", tasks: [{ content: "A" }, { content: "B" }] }] }],
		});

		const result = await tool.execute("c2", {
			ops: [{ op: "update", id: "task-2", status: "abandoned", deferralFupId: "FUP-010-thing" }],
		});

		const task2 = result.details?.groups[0]?.tasks.find((t: TodoItem) => t.id === "task-2");
		expect(task2?.deferralFupId).toBe("FUP-010-thing");
	});

	test("batch: multiple tasks abandoned with same FUP ID", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("c1", {
			ops: [
				{
					op: "replace",
					groups: [{ name: "Work", tasks: [{ content: "A" }, { content: "B" }, { content: "C" }] }],
				},
			],
		});

		const result = await tool.execute("c2", {
			ops: [
				{ op: "update", id: "task-2", status: "abandoned", deferralFupId: "FUP-001-shared" },
				{ op: "update", id: "task-3", status: "abandoned", deferralFupId: "FUP-001-shared" },
			],
		});

		const tasks = result.details?.groups[0]?.tasks ?? [];
		expect(tasks[1].status).toBe("abandoned");
		expect(tasks[2].status).toBe("abandoned");
		expect(tasks[1].deferralFupId).toBe("FUP-001-shared");
		expect(tasks[2].deferralFupId).toBe("FUP-001-shared");
	});

	test("batch: multiple tasks with different FUP IDs", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("c1", {
			ops: [{ op: "replace", groups: [{ name: "Work", tasks: [{ content: "A" }, { content: "B" }] }] }],
		});

		const result = await tool.execute("c2", {
			ops: [
				{ op: "update", id: "task-1", status: "abandoned", deferralFupId: "FUP-001-alpha" },
				{ op: "update", id: "task-2", status: "abandoned", deferralFupId: "FUP-002-beta" },
			],
		});

		const tasks = result.details?.groups[0]?.tasks ?? [];
		expect(tasks[0].deferralFupId).toBe("FUP-001-alpha");
		expect(tasks[1].deferralFupId).toBe("FUP-002-beta");
	});

	test("partial batch: task without FUP rejected while others succeed", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("c1", {
			ops: [{ op: "replace", groups: [{ name: "Work", tasks: [{ content: "A" }, { content: "B" }] }] }],
		});

		const result = await tool.execute("c2", {
			ops: [
				{ op: "update", id: "task-1", status: "abandoned" },
				{ op: "update", id: "task-2", status: "abandoned", deferralFupId: "FUP-003-valid" },
			],
		});

		const tasks = result.details?.groups[0]?.tasks ?? [];
		// task-1 rejected: status unchanged (auto-started to in_progress)
		expect(tasks[0].status).not.toBe("abandoned");
		// task-2 accepted
		expect(tasks[1].status).toBe("abandoned");
		expect(tasks[1].deferralFupId).toBe("FUP-003-valid");
		// Summary contains deferral section for task-1
		expect(summaryText(result)).toContain("Deferral Required");
		expect(summaryText(result)).toContain("task-1");
	});
});

// =============================================================================
// Bypass prevention: tasks always created as pending
// =============================================================================

describe("bypass prevention", () => {
	test("replace op creates tasks as pending", async () => {
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("c1", {
			ops: [{ op: "replace", groups: [{ name: "Work", tasks: [{ content: "A" }, { content: "B" }] }] }],
		});

		const tasks = result.details?.groups[0]?.tasks ?? [];
		// First task auto-started to in_progress, rest pending — none should be abandoned/completed
		for (const task of tasks) {
			expect(["pending", "in_progress"]).toContain(task.status);
		}
	});

	test("add_phase op creates tasks as pending", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("c1", {
			ops: [{ op: "replace", groups: [{ name: "Phase 1", tasks: [{ content: "A" }] }] }],
		});

		const result = await tool.execute("c2", {
			ops: [{ op: "add_phase", name: "Phase 2", tasks: [{ content: "X" }, { content: "Y" }] }],
		});

		const phase2 = result.details?.groups.find((p: TodoGroup) => p.name === "Phase 2");
		expect(phase2).toBeTruthy();
		for (const task of phase2!.tasks) {
			expect(["pending", "in_progress"]).toContain(task.status);
		}
	});
});

// =============================================================================
// Pre-filled deferral template (via formatSummary)
// =============================================================================

describe("pre-filled deferral template", () => {
	test("rejection message includes org create template with task context", () => {
		const task = makeTask({ id: "task-3", content: "Fix the widget", status: "in_progress" });
		const result = callFormatSummary({
			groups: [makePhase("phase-1", "Work", [task])],
			pendingDeferralTasks: [task],
		});

		expect(result).toContain("Deferral Required");
		expect(result).toContain("org create");
		expect(result).toContain("Follow-up: Fix the widget");
		expect(result).toContain("Step 1");
		expect(result).toContain("Step 2");
		expect(result).toContain("deferralFupId");
	});

	test("template includes orgItemId when present", () => {
		const task = makeTask({
			id: "task-1",
			content: "Migrate auth",
			status: "in_progress",
			orgItemId: "FEAT-042-auth",
		});
		const result = callFormatSummary({
			groups: [makePhase("phase-1", "Work", [task])],
			pendingDeferralTasks: [task],
		});

		expect(result).toContain("FEAT-042-auth");
		expect(result).toContain("Source org item");
	});

	test("template includes orgItemClosingId lifecycle transfer warning", () => {
		const task = makeTask({
			id: "task-1",
			content: "Close out feature",
			status: "in_progress",
			orgItemClosingId: "FEAT-099-legacy",
		});
		const result = callFormatSummary({
			groups: [makePhase("phase-1", "Work", [task])],
			pendingDeferralTasks: [task],
		});

		expect(result).toContain("FEAT-099-legacy");
		expect(result).toContain("lifecycle obligation transfers");
	});
});

// =============================================================================
// Phase completion deferral warnings
// =============================================================================

describe("phase completion deferral warnings", () => {
	test("phase with deferred tasks shows warning with FUP IDs", () => {
		const task1 = makeTask({ id: "task-1", content: "Done", status: "completed", gateCommit: true });
		const task2 = makeTask({
			id: "task-2",
			content: "Deferred",
			status: "abandoned",
			deferralFupId: "FUP-005-handle-later",
		});
		const result = callFormatSummary({
			groups: [makePhase("phase-1", "Build", [task1, task2])],
			completedGroupIds: ["phase-1"],
		});

		expect(result).toContain('Group "Build" complete.');
		expect(result).toContain("WARNING");
		expect(result).toContain("FUP-005-handle-later");
		expect(result).toContain("task-2");
	});

	test("phase without deferred tasks shows no deferral warning", () => {
		const task1 = makeTask({ id: "task-1", content: "Done", status: "completed", gateCommit: true });
		const result = callFormatSummary({
			groups: [makePhase("phase-1", "Build", [task1])],
			completedGroupIds: ["phase-1"],
		});

		expect(result).toContain('Group "Build" complete.');
		expect(result).not.toContain("WARNING");
		expect(result).not.toContain("deferred");
	});
});

// =============================================================================
// Auto-clear behavior: abandoned tasks persist
// =============================================================================

describe("auto-clear behavior", () => {
	test("abandoned tasks remain visible after subsequent operations", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("c1", {
			ops: [
				{
					op: "replace",
					groups: [{ name: "Work", tasks: [{ content: "A" }, { content: "B" }, { content: "C" }] }],
				},
			],
		});

		// Abandon task-1 with FUP, complete task-2
		await tool.execute("c2", {
			ops: [{ op: "update", id: "task-1", status: "abandoned", deferralFupId: "FUP-010-later" }],
		});
		const result = await tool.execute("c3", {
			ops: [{ op: "update", id: "task-2", status: "completed" }],
		});

		const tasks = result.details?.groups[0]?.tasks ?? [];
		const abandoned = tasks.find((t: TodoItem) => t.id === "task-1");
		expect(abandoned).toBeTruthy();
		expect(abandoned!.status).toBe("abandoned");
		expect(abandoned!.deferralFupId).toBe("FUP-010-later");
	});

	test("abandoned task renders ✗ symbol in summary", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("c1", {
			ops: [
				{ op: "replace", groups: [{ name: "Work", tasks: [{ content: "Drop this" }, { content: "Keep this" }] }] },
			],
		});

		const result = await tool.execute("c2", {
			ops: [{ op: "update", id: "task-1", status: "abandoned", deferralFupId: "FUP-020-gone" }],
		});

		expect(summaryText(result)).toContain("✗");
	});
});

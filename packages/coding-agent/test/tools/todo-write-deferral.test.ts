/**
 * Tests for deferral gate enforcement on todo_write.
 *
 * Contracts:
 *   - Abandonment without deferralFupId is rejected; task stays unchanged
 *   - Empty/whitespace-only deferralFupId treated as missing
 *   - Valid deferralFupId allows abandonment and is stored on the task
 *   - Batch ops: valid items succeed even when others are rejected
 *   - formatSummary shows "Deferral Required" with org create template
 *   - Template includes ref / closesRef context when present
 *   - Group completion warns about deferred tasks with FUP IDs
 *   - Replace/add tasks always create nodes as pending
 *   - Abandoned tasks survive (not auto-cleared)
 */

import { describe, expect, test } from "bun:test";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import type { ToolSession } from "../../src/tools";
import type { FormatSummaryOptions, TodoNode, TodoStatus } from "../../src/tools/todo-write";
import { formatSummary, TodoWriteTool } from "../../src/tools/todo-write";

// =============================================================================
// Helpers
// =============================================================================

function makeNode(overrides: Partial<TodoNode> & { id: string; content: string }): TodoNode {
	return { status: "pending" as TodoStatus, ...overrides };
}

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

function callFormatSummary(overrides: Partial<FormatSummaryOptions> = {}): string {
	return formatSummary({
		nodes: overrides.nodes ?? [makeNode({ id: "task-1", content: "Do thing" })],
		errors: overrides.errors ?? [],
		completedGroups: overrides.completedGroups ?? [],
		completedGatedNodes: overrides.completedGatedNodes ?? [],
		pendingVerificationNodes: overrides.pendingVerificationNodes ?? [],
		pendingDeferralNodes: overrides.pendingDeferralNodes ?? [],
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
			reset: true,
			tasks: [{ content: "Build it", group: "Work" }],
		});

		const result = await tool.execute("c2", {
			tasks: [{ id: "task-1", status: "abandoned" }],
		});

		const nodes = result.details?.nodes ?? [];
		expect(nodes[0].status).not.toBe("abandoned");
		const text = summaryText(result);
		expect(text).toContain("Deferral Required");
		expect(text).toContain("org create");
	});

	test("rejects abandonment with empty string deferralFupId", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("c1", {
			reset: true,
			tasks: [{ content: "Build it", group: "Work" }],
		});

		const result = await tool.execute("c2", {
			tasks: [{ id: "task-1", status: "abandoned", deferralFupId: "" }],
		});

		const nodes = result.details?.nodes ?? [];
		expect(nodes[0].status).not.toBe("abandoned");
		expect(summaryText(result)).toContain("Deferral Required");
	});

	test("rejects abandonment with whitespace-only deferralFupId", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("c1", {
			reset: true,
			tasks: [{ content: "Build it", group: "Work" }],
		});

		const result = await tool.execute("c2", {
			tasks: [{ id: "task-1", status: "abandoned", deferralFupId: "   " }],
		});

		const nodes = result.details?.nodes ?? [];
		expect(nodes[0].status).not.toBe("abandoned");
		expect(summaryText(result)).toContain("Deferral Required");
	});

	test("accepts abandonment with valid deferralFupId", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("c1", {
			reset: true,
			tasks: [{ content: "Build it", group: "Work" }],
		});

		const result = await tool.execute("c2", {
			tasks: [{ id: "task-1", status: "abandoned", deferralFupId: "FUP-008-handle-retries" }],
		});

		const nodes = result.details?.nodes ?? [];
		expect(nodes[0].status).toBe("abandoned");
		expect(nodes[0].deferralFupId).toBe("FUP-008-handle-retries");
		expect(summaryText(result)).not.toContain("Deferral Required");
	});

	test("stores deferralFupId on node in result nodes", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("c1", {
			reset: true,
			tasks: [{ content: "A", group: "Work" }, { content: "B", group: "Work" }],
		});

		const result = await tool.execute("c2", {
			tasks: [{ id: "task-2", status: "abandoned", deferralFupId: "FUP-010-thing" }],
		});

		const task2 = result.details?.nodes.find((n: TodoNode) => n.id === "task-2");
		expect(task2?.deferralFupId).toBe("FUP-010-thing");
	});

	test("batch: multiple tasks abandoned with same FUP ID", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("c1", {
			reset: true,
			tasks: [
				{ content: "A", group: "Work" },
				{ content: "B", group: "Work" },
				{ content: "C", group: "Work" },
			],
		});

		const result = await tool.execute("c2", {
			tasks: [
				{ id: "task-2", status: "abandoned", deferralFupId: "FUP-001-shared" },
				{ id: "task-3", status: "abandoned", deferralFupId: "FUP-001-shared" },
			],
		});

		const nodes = result.details?.nodes ?? [];
		expect(nodes[1].status).toBe("abandoned");
		expect(nodes[2].status).toBe("abandoned");
		expect(nodes[1].deferralFupId).toBe("FUP-001-shared");
		expect(nodes[2].deferralFupId).toBe("FUP-001-shared");
	});

	test("batch: multiple tasks with different FUP IDs", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("c1", {
			reset: true,
			tasks: [{ content: "A", group: "Work" }, { content: "B", group: "Work" }],
		});

		const result = await tool.execute("c2", {
			tasks: [
				{ id: "task-1", status: "abandoned", deferralFupId: "FUP-001-alpha" },
				{ id: "task-2", status: "abandoned", deferralFupId: "FUP-002-beta" },
			],
		});

		const nodes = result.details?.nodes ?? [];
		expect(nodes[0].deferralFupId).toBe("FUP-001-alpha");
		expect(nodes[1].deferralFupId).toBe("FUP-002-beta");
	});

	test("partial batch: task without FUP rejected while others succeed", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("c1", {
			reset: true,
			tasks: [{ content: "A", group: "Work" }, { content: "B", group: "Work" }],
		});

		const result = await tool.execute("c2", {
			tasks: [
				{ id: "task-1", status: "abandoned" },
				{ id: "task-2", status: "abandoned", deferralFupId: "FUP-003-valid" },
			],
		});

		const nodes = result.details?.nodes ?? [];
		// task-1 rejected: status unchanged (auto-started to in_progress)
		expect(nodes[0].status).not.toBe("abandoned");
		// task-2 accepted
		expect(nodes[1].status).toBe("abandoned");
		expect(nodes[1].deferralFupId).toBe("FUP-003-valid");
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
			reset: true,
			tasks: [{ content: "A", group: "Work" }, { content: "B", group: "Work" }],
		});

		const nodes = result.details?.nodes ?? [];
		// First task auto-started to in_progress, rest pending — none should be abandoned/completed
		for (const node of nodes) {
			expect(["pending", "in_progress"]).toContain(node.status);
		}
	});

	test("add_phase op creates tasks as pending", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("c1", {
			reset: true,
			tasks: [{ content: "A", group: "Phase 1" }],
		});

		const result = await tool.execute("c2", {
			tasks: [{ content: "X", group: "Phase 2" }, { content: "Y", group: "Phase 2" }],
		});

		const phase2Nodes = result.details?.nodes.filter((n: TodoNode) => n.group === "Phase 2") ?? [];
		expect(phase2Nodes.length).toBe(2);
		for (const node of phase2Nodes) {
			expect(["pending", "in_progress"]).toContain(node.status);
		}
	});
});

// =============================================================================
// Pre-filled deferral template (via formatSummary)
// =============================================================================

describe("pre-filled deferral template", () => {
	test("rejection message includes org create template with task context", () => {
		const node = makeNode({ id: "task-3", content: "Fix the widget", status: "in_progress" });
		const result = callFormatSummary({
			nodes: [node],
			pendingDeferralNodes: [node],
		});

		expect(result).toContain("Deferral Required");
		expect(result).toContain("org create");
		expect(result).toContain("Follow-up: Fix the widget");
		expect(result).toContain("Step 1");
		expect(result).toContain("Step 2");
		expect(result).toContain("deferralFupId");
	});

	test("template includes ref when present", () => {
		const node = makeNode({
			id: "task-1",
			content: "Migrate auth",
			status: "in_progress",
			ref: "org://FEAT-042-auth",
		});
		const result = callFormatSummary({
			nodes: [node],
			pendingDeferralNodes: [node],
		});

		expect(result).toContain("FEAT-042-auth");
		expect(result).toContain("Source org item");
	});

	test("template includes closesRef lifecycle transfer warning", () => {
		const node = makeNode({
			id: "task-1",
			content: "Close out feature",
			status: "in_progress",
			ref: "org://FEAT-099-legacy",
			closesRef: true,
		});
		const result = callFormatSummary({
			nodes: [node],
			pendingDeferralNodes: [node],
		});

		expect(result).toContain("FEAT-099-legacy");
		expect(result).toContain("lifecycle obligation transfers");
	});
});

// =============================================================================
// Group completion deferral warnings
// =============================================================================

describe("group completion deferral warnings", () => {
	test("group with deferred tasks shows warning with FUP IDs", () => {
		const node1 = makeNode({ id: "task-1", content: "Done", status: "completed", group: "Build", verify: { commit: true } });
		const node2 = makeNode({
			id: "task-2",
			content: "Deferred",
			status: "abandoned",
			group: "Build",
			deferralFupId: "FUP-005-handle-later",
		});
		const result = callFormatSummary({
			nodes: [node1, node2],
			completedGroups: ["Build"],
		});

		expect(result).toContain('Group "Build" complete.');
		expect(result).toContain("WARNING");
		expect(result).toContain("FUP-005-handle-later");
		expect(result).toContain("task-2");
	});

	test("group without deferred tasks shows no deferral warning", () => {
		const node1 = makeNode({ id: "task-1", content: "Done", status: "completed", group: "Build", verify: { commit: true } });
		const result = callFormatSummary({
			nodes: [node1],
			completedGroups: ["Build"],
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
			reset: true,
			tasks: [
				{ content: "A", group: "Work" },
				{ content: "B", group: "Work" },
				{ content: "C", group: "Work" },
			],
		});

		// Abandon task-1 with FUP, complete task-2
		await tool.execute("c2", {
			tasks: [{ id: "task-1", status: "abandoned", deferralFupId: "FUP-010-later" }],
		});
		const result = await tool.execute("c3", {
			tasks: [{ id: "task-2", status: "completed" }],
		});

		const nodes = result.details?.nodes ?? [];
		const abandoned = nodes.find((n: TodoNode) => n.id === "task-1");
		expect(abandoned).toBeTruthy();
		expect(abandoned!.status).toBe("abandoned");
		expect(abandoned!.deferralFupId).toBe("FUP-010-later");
	});

	test("abandoned task renders ✗ symbol in summary", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("c1", {
			reset: true,
			tasks: [{ content: "Drop this", group: "Work" }, { content: "Keep this", group: "Work" }],
		});

		const result = await tool.execute("c2", {
			tasks: [{ id: "task-1", status: "abandoned", deferralFupId: "FUP-020-gone" }],
		});

		expect(summaryText(result)).toContain("✗");
	});
});
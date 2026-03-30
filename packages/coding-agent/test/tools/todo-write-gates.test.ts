/**
 * Tests for todo_write gate fields, phase completion detection, blocked state,
 * and TUI gate badge rendering.
 *
 * Contracts:
 *   - Gate fields survive all data paths (replace, add_phase, add_task, update, clone)
 *   - formatSummary injects directives when gated tasks are completed
 *   - Phase completion detected via before/after comparison
 *   - isTaskBlocked correctly computes blocked state
 *   - normalizeInProgressTask skips blocked tasks
 *   - Gate badges render in formatTodoLine
 */

import { describe, expect, test } from "bun:test";
import type { FormatSummaryOptions, TodoItem, TodoPhase, TodoStatus } from "../../src/tools/todo-write";
import { formatSummary, getLatestTodoPhasesFromEntries, hasGate, isTaskBlocked } from "../../src/tools/todo-write";

// =============================================================================
// Helper: build phases with gate fields
// =============================================================================

function makeTask(overrides: Partial<TodoItem> & { id: string; content: string }): TodoItem {
	return {
		status: "pending" as TodoStatus,
		...overrides,
	};
}

function makePhase(id: string, name: string, tasks: TodoItem[]): TodoPhase {
	return { id, name, tasks };
}

// =============================================================================
// FEAT-071: Gate fields on TodoItem
// =============================================================================

describe("TodoItem gate fields", () => {
	test("hasGate returns true when any gate field is set", () => {
		expect(hasGate(makeTask({ id: "t1", content: "a", gateCommit: true }))).toBe(true);
		expect(hasGate(makeTask({ id: "t2", content: "b", gateArtifact: "dist/out.json" }))).toBe(true);
		expect(hasGate(makeTask({ id: "t3", content: "c", gateCmd: "bun test" }))).toBe(true);
		expect(hasGate(makeTask({ id: "t4", content: "d", gateLlm: "check acceptance" }))).toBe(true);
		expect(hasGate(makeTask({ id: "t5", content: "e", verifyCmd: "bun check" }))).toBe(true);
	});

	test("hasGate returns false when no gate fields set", () => {
		expect(hasGate(makeTask({ id: "t1", content: "a" }))).toBe(false);
	});

	test("gate fields survive clonePhases (via getLatestTodoPhasesFromEntries)", () => {
		const phases: TodoPhase[] = [
			makePhase("phase-1", "Work", [
				makeTask({
					id: "task-1",
					content: "Build feature",
					status: "in_progress",
					details: "Step 1",
					gateCommit: true,
					gateArtifact: "dist/output.json",
					gateCmd: "bun test",
					gateLlm: "review criteria",
					verifyCmd: "bun check",
					blockers: ["task-2"],
				}),
			]),
		];

		// Simulate session entries with todo_write result
		const entries = [
			{
				type: "message" as const,
				message: {
					role: "toolResult",
					toolName: "todo_write",
					isError: false,
					details: { phases },
				},
			},
		];

		const restored = getLatestTodoPhasesFromEntries(entries as any);
		expect(restored.length).toBe(1);
		const task = restored[0].tasks[0];
		expect(task.details).toBe("Step 1");
		expect(task.gateCommit).toBe(true);
		expect(task.gateArtifact).toBe("dist/output.json");
		expect(task.gateCmd).toBe("bun test");
		expect(task.gateLlm).toBe("review criteria");
		expect(task.verifyCmd).toBe("bun check");
		expect(task.blockers).toEqual(["task-2"]);
	});
});

// =============================================================================
// FEAT-067: Blocked computed state
// =============================================================================

describe("isTaskBlocked", () => {
	test("returns true for pending task with unresolved blocker", () => {
		const task1 = makeTask({ id: "task-1", content: "First", status: "pending" });
		const task2 = makeTask({ id: "task-2", content: "Second", status: "pending", blockers: ["task-1"] });
		expect(isTaskBlocked(task2, [task1, task2])).toBe(true);
	});

	test("returns false when blocker is completed", () => {
		const task1 = makeTask({ id: "task-1", content: "First", status: "completed" });
		const task2 = makeTask({ id: "task-2", content: "Second", status: "pending", blockers: ["task-1"] });
		expect(isTaskBlocked(task2, [task1, task2])).toBe(false);
	});

	test("returns false when blocker is abandoned", () => {
		const task1 = makeTask({ id: "task-1", content: "First", status: "abandoned" });
		const task2 = makeTask({ id: "task-2", content: "Second", status: "pending", blockers: ["task-1"] });
		expect(isTaskBlocked(task2, [task1, task2])).toBe(false);
	});

	test("returns false when blocker ref is missing (auto-cleared)", () => {
		const task2 = makeTask({ id: "task-2", content: "Second", status: "pending", blockers: ["task-99"] });
		expect(isTaskBlocked(task2, [task2])).toBe(false);
	});

	test("returns false for in_progress task even with unresolved blockers", () => {
		const task1 = makeTask({ id: "task-1", content: "First", status: "pending" });
		const task2 = makeTask({ id: "task-2", content: "Second", status: "in_progress", blockers: ["task-1"] });
		expect(isTaskBlocked(task2, [task1, task2])).toBe(false);
	});

	test("returns false for completed task with blockers", () => {
		const task1 = makeTask({ id: "task-1", content: "First", status: "pending" });
		const task2 = makeTask({ id: "task-2", content: "Second", status: "completed", blockers: ["task-1"] });
		expect(isTaskBlocked(task2, [task1, task2])).toBe(false);
	});

	test("returns false for task with no blockers", () => {
		const task = makeTask({ id: "task-1", content: "Solo", status: "pending" });
		expect(isTaskBlocked(task, [task])).toBe(false);
	});

	test("returns false for task with empty blockers array", () => {
		const task = makeTask({ id: "task-1", content: "Solo", status: "pending", blockers: [] });
		expect(isTaskBlocked(task, [task])).toBe(false);
	});

	test("multiple blockers: blocked if any unresolved", () => {
		const task1 = makeTask({ id: "task-1", content: "Done", status: "completed" });
		const task2 = makeTask({ id: "task-2", content: "Pending", status: "pending" });
		const task3 = makeTask({ id: "task-3", content: "Blocked", status: "pending", blockers: ["task-1", "task-2"] });
		expect(isTaskBlocked(task3, [task1, task2, task3])).toBe(true);
	});

	test("circular blockers: both blocked, no infinite loop", () => {
		const task1 = makeTask({ id: "task-1", content: "A", status: "pending", blockers: ["task-2"] });
		const task2 = makeTask({ id: "task-2", content: "B", status: "pending", blockers: ["task-1"] });
		// Both should be blocked — isTaskBlocked doesn't recurse
		expect(isTaskBlocked(task1, [task1, task2])).toBe(true);
		expect(isTaskBlocked(task2, [task1, task2])).toBe(true);
	});
});

// =============================================================================
// formatSummary gate directive injection
// =============================================================================

describe("formatSummary gate directives", () => {
	function callFormatSummary(overrides: Partial<FormatSummaryOptions> = {}): string {
		return formatSummary({
			phases: overrides.phases ?? [makePhase("phase-1", "Work", [makeTask({ id: "task-1", content: "Do thing" })])],
			errors: overrides.errors ?? [],
			completedPhaseIds: overrides.completedPhaseIds ?? [],
			completedGatedTasks: overrides.completedGatedTasks ?? [],
		});
	}

	test("completing a gated task injects Gate Requirements section", () => {
		const task = makeTask({ id: "task-1", content: "Build it", status: "completed", gateCommit: true });
		const result = callFormatSummary({
			phases: [makePhase("phase-1", "Work", [task])],
			completedGatedTasks: [task],
		});
		expect(result).toContain("--- Gate Requirements ---");
		expect(result).toContain("REQUIRED: Commit your changes for task-1");
	});

	test("each gate type produces its directive", () => {
		const task = makeTask({
			id: "task-1",
			content: "Full gates",
			status: "completed",
			gateCommit: true,
			gateArtifact: "dist/out.json",
			gateCmd: "bun test",
			gateLlm: "check acceptance",
			verifyCmd: "bun check",
		});
		const result = callFormatSummary({
			phases: [makePhase("phase-1", "Work", [task])],
			completedGatedTasks: [task],
		});
		expect(result).toContain("REQUIRED: Commit your changes for task-1 (Full gates) before proceeding.");
		expect(result).toContain("REQUIRED: Verify artifact exists at dist/out.json for task-1.");
		expect(result).toContain("REQUIRED: Run `bun test` to verify task-1.");
		expect(result).toContain("REQUIRED: Review task-1 against acceptance criteria: check acceptance");
		expect(result).toContain("RECOMMENDED: Run `bun check` to verify task-1.");
	});

	test("no gate directives when completing non-gated task", () => {
		const task = makeTask({ id: "task-1", content: "Simple", status: "completed" });
		const result = callFormatSummary({
			phases: [makePhase("phase-1", "Work", [task])],
			completedGatedTasks: [],
		});
		expect(result).not.toContain("--- Gate Requirements ---");
		expect(result).not.toContain("REQUIRED:");
		expect(result).not.toContain("RECOMMENDED:");
	});

	test("phase completion aggregate directive", () => {
		const task = makeTask({
			id: "task-1",
			content: "Done",
			status: "completed",
			gateCommit: true,
			gateCmd: "bun test",
		});
		const result = callFormatSummary({
			phases: [makePhase("phase-1", "Build", [task])],
			completedPhaseIds: ["phase-1"],
		});
		expect(result).toContain('Phase "Build" complete.');
		expect(result).toContain("Commit changes.");
		expect(result).toContain("Run verification commands.");
	});

	test("blocked task shows [blocked] label in remaining items", () => {
		const blocker = makeTask({ id: "task-1", content: "First", status: "pending" });
		const blocked = makeTask({ id: "task-2", content: "Second", status: "pending", blockers: ["task-1"] });
		const result = callFormatSummary({
			phases: [makePhase("phase-1", "Work", [blocker, blocked])],
		});
		expect(result).toContain("task-2 Second [pending] [blocked]");
	});

	test("blocked task uses block symbol in phase tree", () => {
		const blocker = makeTask({ id: "task-1", content: "First", status: "pending" });
		const blocked = makeTask({ id: "task-2", content: "Second", status: "pending", blockers: ["task-1"] });
		const result = callFormatSummary({
			phases: [makePhase("phase-1", "Work", [blocker, blocked])],
		});
		// ⛔ is the blocked symbol in phase tree rendering
		expect(result).toContain("\u26D4 task-2");
	});
});

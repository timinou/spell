/**
 * Tests for todoRef → verification context injection.
 *
 * Contracts:
 *   - resolveVerificationContext builds correct block for a gated todo
 *   - resolveVerificationContext returns undefined for non-existent todoRef
 *   - resolveVerificationContext returns undefined for gateless todo
 *   - verifyCmd produces SHOULD (advisory) vs MUST (required) distinction
 *   - orgItemId produces org update directive
 *   - renderTemplate with augmented assignment includes verification section
 */

import { describe, expect, test } from "bun:test";

import {
	renderTemplate,
	resolvePredecessorResultsContext,
	resolveVerificationContext,
} from "@spell/pi-coding-agent/task/template";

import type { TodoGroup, TodoItem } from "@spell/pi-coding-agent/tools/todo-write";

function makeTask(overrides: Partial<TodoItem> & { id: string; content: string }): TodoItem {
	return { status: "in_progress", ...overrides };
}

function makeGroup(id: string, name: string, tasks: TodoItem[]): TodoGroup {
	return { id, name, tasks };
}

describe("resolveVerificationContext", () => {
	test("returns correct block for a todo with all gates set", () => {
		const groups = [
			makeGroup("phase-1", "Work", [
				makeTask({
					id: "task-1",
					content: "Build feature",
					gateCmd: "bun test test/foo.test.ts",
					gateArtifact: "screenshots/auth-flow.png",
					gateCommit: true,
					gateLlm: "check acceptance criteria",
					verifyCmd: "bun check:ts",
					orgItemId: "FEAT-001-add-auth",
					orgItemClosingId: "FEAT-001-add-auth",
				}),
			]),
		];
		const result = resolveVerificationContext("task-1", groups)!;
		expect(result).toContain("--- Verification Requirements (from task-1) ---");
		expect(result).toContain("You MUST run: `bun test test/foo.test.ts` and verify it passes.");
		expect(result).toContain("You MUST produce artifact at: screenshots/auth-flow.png");
		expect(result).toContain("You MUST commit changes before yielding.");
		expect(result).toContain("You MUST self-review against: check acceptance criteria");
		expect(result).toContain("You SHOULD run: `bun check:ts` to verify.");
		expect(result).toContain("You MUST update org item FEAT-001-add-auth");
	});

	test("returns undefined for non-existent todoRef", () => {
		const groups = [makeGroup("phase-1", "Work", [makeTask({ id: "task-1", content: "Exists" })])];
		expect(resolveVerificationContext("task-99", groups)).toBeUndefined();
	});

	test("returns undefined for gateless todo", () => {
		const groups = [makeGroup("phase-1", "Work", [makeTask({ id: "task-1", content: "No gates" })])];
		expect(resolveVerificationContext("task-1", groups)).toBeUndefined();
	});

	test("returns undefined for empty groups", () => {
		expect(resolveVerificationContext("task-1", [])).toBeUndefined();
	});

	test("resolves across multiple groups", () => {
		const groups = [
			makeGroup("phase-1", "Foundation", [makeTask({ id: "task-1", content: "Schema" })]),
			makeGroup("phase-2", "Features", [
				makeTask({
					id: "task-2",
					content: "API",
					gateCmd: "bun test",
				}),
			]),
		];
		const result = resolveVerificationContext("task-2", groups)!;
		expect(result).toContain("You MUST run: `bun test`");
	});

	test("orgItemId-only todo produces context", () => {
		const groups = [
			makeGroup("phase-1", "Work", [
				makeTask({ id: "task-1", content: "Org linked", orgItemId: "FEAT-005-refactor" }),
			]),
		];
		const result = resolveVerificationContext("task-1", groups)!;
		expect(result).toContain("FEAT-005-refactor");
		expect(result).toContain("--- Verification Requirements (from task-1) ---");
	});

	test("verifyCmd alone produces advisory context", () => {
		const groups = [
			makeGroup("phase-1", "Work", [makeTask({ id: "task-1", content: "Advisory", verifyCmd: "bun lint" })]),
		];
		const result = resolveVerificationContext("task-1", groups)!;
		expect(result).toContain("You SHOULD run: `bun lint` to verify.");
		expect(result).not.toContain("You MUST");
	});
});

describe("resolvePredecessorResultsContext", () => {
	test("renders completed blocker outputs for dependent tasks", () => {
		const groups = [
			makeGroup("phase-1", "Work", [
				makeTask({
					id: "task-1",
					content: "Build schema",
					status: "completed",
					delegation: {
						sessionId: "child-session",
						transcriptPath: "/tmp/child.jsonl",
						result: {
							output: "Schema summary",
							outputPath: "/tmp/child.md",
						},
					},
				}),
				makeTask({ id: "task-2", content: "Build API", blockers: ["task-1"] }),
			]),
		];
		const result = resolvePredecessorResultsContext("task-2", groups)!;
		expect(result).toContain("--- Predecessor Results (from task-2 blockers) ---");
		expect(result).toContain("### task-1 — Build schema");
		expect(result).toContain("Output artifact: /tmp/child.md");
		expect(result).toContain("Schema summary");
	});

	test("returns undefined when blockers have no completed result data", () => {
		const groups = [
			makeGroup("phase-1", "Work", [
				makeTask({ id: "task-1", content: "Build schema", status: "completed" }),
				makeTask({ id: "task-2", content: "Build API", blockers: ["task-1"] }),
			]),
		];
		expect(resolvePredecessorResultsContext("task-2", groups)).toBeUndefined();
	});
});

describe("renderTemplate with augmented assignment", () => {
	test("verification context appears in rendered task", () => {
		const verificationBlock = "--- Verification Requirements (from task-1) ---\nYou MUST run: `bun test`";
		const augmentedAssignment = `Do the thing.\n\n${verificationBlock}`;

		const result = renderTemplate("Shared context", {
			id: "DoWork",
			description: "Do work",
			assignment: augmentedAssignment,
		});
		expect(result.task).toContain("--- Verification Requirements (from task-1) ---");
		expect(result.task).toContain("You MUST run: `bun test`");
		expect(result.task).toContain("Do the thing.");
		expect(result.task).toContain("Shared context");
	});

	test("renderTemplate without verification context is unchanged", () => {
		const result = renderTemplate("Context", {
			id: "Plain",
			description: "Plain task",
			assignment: "Just an assignment",
		});
		expect(result.task).not.toContain("Verification Requirements");
		expect(result.task).toContain("Just an assignment");
	});
});

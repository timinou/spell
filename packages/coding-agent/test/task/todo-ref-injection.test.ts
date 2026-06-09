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

import type { TodoNode } from "@spell/pi-coding-agent/tools/todo-write";

function makeNode(overrides: Partial<TodoNode> & { id: string; content: string }): TodoNode {
	return { status: "in_progress", ...overrides };
}

describe("resolveVerificationContext", () => {
	test("returns correct block for a todo with all gates set", () => {
		const nodes = [
			makeNode({
				id: "task-1",
				content: "Build feature",
				group: "Work",
				verify: {
					cmd: "bun test test/foo.test.ts",
					artifact: "screenshots/auth-flow.png",
					commit: true,
					review: "check acceptance criteria",
				},
				ref: "org://FEAT-001-add-auth",
				closesRef: true,
			}),
		];
		const result = resolveVerificationContext("task-1", nodes)!;
		expect(result).toContain("--- Verification Requirements (from task-1) ---");
		expect(result).toContain("You MUST run: `bun test test/foo.test.ts` and verify it passes.");
		expect(result).toContain("You MUST produce artifact at: screenshots/auth-flow.png");
		expect(result).toContain("You MUST commit changes before yielding.");
		expect(result).toContain("You MUST self-review against: check acceptance criteria");
		expect(result).toContain("You MUST update org item FEAT-001-add-auth");
	});

	test("returns undefined for non-existent todoRef", () => {
		const nodes = [makeNode({ id: "task-1", content: "Exists", group: "Work" })];
		expect(resolveVerificationContext("task-99", nodes)).toBeUndefined();
	});

	test("returns undefined for gateless todo", () => {
		const nodes = [makeNode({ id: "task-1", content: "No gates", group: "Work" })];
		expect(resolveVerificationContext("task-1", nodes)).toBeUndefined();
	});

	test("returns undefined for empty nodes", () => {
		expect(resolveVerificationContext("task-1", [])).toBeUndefined();
	});

	test("resolves across multiple nodes", () => {
		const nodes = [
			makeNode({ id: "task-1", content: "Schema", group: "Foundation" }),
			makeNode({
				id: "task-2",
				content: "API",
				group: "Features",
				verify: { cmd: "bun test" },
			}),
		];
		const result = resolveVerificationContext("task-2", nodes)!;
		expect(result).toContain("You MUST run: `bun test`");
	});

	test("ref-only todo produces context", () => {
		const nodes = [
			makeNode({ id: "task-1", content: "Org linked", group: "Work", ref: "org://FEAT-005-refactor" }),
		];
		const result = resolveVerificationContext("task-1", nodes)!;
		expect(result).toContain("FEAT-005-refactor");
		expect(result).toContain("--- Verification Requirements (from task-1) ---");
	});

	test("review produces verification context", () => {
		const nodes = [
			makeNode({ id: "task-1", content: "Advisory", group: "Work", verify: { review: "check lint" } }),
		];
		const result = resolveVerificationContext("task-1", nodes)!;
		expect(result).toContain("You MUST self-review against: check lint");
	});
});

describe("resolvePredecessorResultsContext", () => {
	test("renders completed blocker outputs for dependent tasks", () => {
		const nodes = [
			makeNode({
				id: "task-1",
				content: "Build schema",
				group: "Work",
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
			makeNode({ id: "task-2", content: "Build API", group: "Work", blockers: ["task-1"] }),
		];
		const result = resolvePredecessorResultsContext("task-2", nodes)!;
		expect(result).toContain("--- Predecessor Results (from task-2 blockers) ---");
		expect(result).toContain("### task-1 — Build schema");
		expect(result).toContain("Output artifact: /tmp/child.md");
		expect(result).toContain("Schema summary");
	});

	test("returns undefined when blockers have no completed result data", () => {
		const nodes = [
			makeNode({ id: "task-1", content: "Build schema", group: "Work", status: "completed" }),
			makeNode({ id: "task-2", content: "Build API", group: "Work", blockers: ["task-1"] }),
		];
		expect(resolvePredecessorResultsContext("task-2", nodes)).toBeUndefined();
	});
});

describe("renderTemplate with augmented assignment", () => {
	test("verification context appears in rendered task", () => {
		const verificationBlock = "--- Verification Requirements (from task-1) ---\nYou MUST run: `bun test`";
		const augmentedAssignment = `Do the thing.\n\n${verificationBlock}`;

		const result = renderTemplate("Shared context", {
			id: "DoWork",
			description: "Do work",
			assignment: augmentedAssignment, ref: null });
		expect(result.task).toContain("--- Verification Requirements (from task-1) ---");
		expect(result.task).toContain("You MUST run: `bun test`");
		expect(result.task).toContain("Do the thing.");
		expect(result.task).toContain("Shared context");
	});

	test("renderTemplate without verification context is unchanged", () => {
		const result = renderTemplate("Context", {
			id: "Plain",
			description: "Plain task",
			assignment: "Just an assignment", ref: null });
		expect(result.task).not.toContain("Verification Requirements");
		expect(result.task).toContain("Just an assignment");
	});
});

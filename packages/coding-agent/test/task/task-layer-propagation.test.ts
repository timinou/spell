import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import type { TaskPolicy } from "../../src/config/task-policies";
import { resolveVerificationContext } from "../../src/task/template";
import { taskItemSchema } from "../../src/task/types";
import type { TodoPhase } from "../../src/tools/todo-write";

const testPolicies: TaskPolicy[] = [
	{
		name: "frontend-tests",
		match: { layer: "frontend" },
		gates: { gateCmd: "mix test test/journey/" },
		inject: "Write journey tests covering the complete user flow.",
	},
];

function makePhases(layer?: string): TodoPhase[] {
	return [
		{
			id: "phase-1",
			name: "test",
			tasks: [
				{
					id: "task-1",
					content: "Build UI",
					status: "pending",
					layer,
					gateCmd: "mix test",
				},
			],
		},
	];
}

describe("task layer propagation", () => {
	describe("resolveVerificationContext with policies", () => {
		test("includes policy inject text for layer-tagged todo", () => {
			const phases = makePhases("frontend");
			const result = resolveVerificationContext("task-1", phases, testPolicies);
			expect(result).toBeDefined();
			expect(result).toContain("Write journey tests");
			expect(result).toContain("Policy Guidance");
		});

		test("no policy inject text without layer", () => {
			const phases = makePhases();
			const result = resolveVerificationContext("task-1", phases, testPolicies);
			expect(result).toBeDefined();
			expect(result).toContain("mix test");
			expect(result).not.toContain("Policy Guidance");
		});

		test("no policy inject text with unmatched layer", () => {
			const phases = makePhases("backend");
			const result = resolveVerificationContext("task-1", phases, testPolicies);
			expect(result).toBeDefined();
			expect(result).not.toContain("Policy Guidance");
		});

		test("no policy inject text without policies", () => {
			const phases = makePhases("frontend");
			const result = resolveVerificationContext("task-1", phases);
			expect(result).toBeDefined();
			expect(result).not.toContain("Policy Guidance");
		});

		test("policy inject text appears after gate requirements", () => {
			const phases = makePhases("frontend");
			const result = resolveVerificationContext("task-1", phases, testPolicies)!;
			const gateIdx = result.indexOf("mix test");
			const policyIdx = result.indexOf("Policy Guidance");
			expect(gateIdx).toBeLessThan(policyIdx);
		});
	});

	describe("TaskItem layer field", () => {
		test("taskItemSchema accepts layer field", () => {
			expect(
				Value.Check(taskItemSchema, {
					id: "inspectFile",
					description: "Inspect file",
					assignment: "## Target\n- File: foo.ts",
					layer: "frontend",
				}),
			).toBe(true);
		});
	});
});

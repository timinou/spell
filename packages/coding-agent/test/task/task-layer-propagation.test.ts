import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import type { TaskPolicy } from "../../src/config/task-policies";
import { resolveVerificationContext } from "../../src/task/template";
import { taskItemSchema } from "../../src/task/types";
import type { TodoNode } from "../../src/tools/todo-write";

const testPolicies: TaskPolicy[] = [
	{
		name: "frontend-tests",
		match: { layer: "frontend" },
		verify: { cmd: "mix test test/journey/" },
		inject: "Write journey tests covering the complete user flow.",
	},
];

function makeNodes(layer?: string): TodoNode[] {
	return [
		{
			id: "task-1",
			content: "Build UI",
			status: "pending",
			group: "test",
			layer,
			verify: { cmd: "mix test" },
		},
	];
}

describe("task layer propagation", () => {
	describe("resolveVerificationContext with policies", () => {
		test("includes policy inject text for layer-tagged todo", () => {
			const nodes = makeNodes("frontend");
			const result = resolveVerificationContext("task-1", nodes, testPolicies);
			expect(result).toBeDefined();
			expect(result).toContain("Write journey tests");
			expect(result).toContain("Policy Guidance");
		});

		test("no policy inject text without layer", () => {
			const nodes = makeNodes();
			const result = resolveVerificationContext("task-1", nodes, testPolicies);
			expect(result).toBeDefined();
			expect(result).toContain("mix test");
			expect(result).not.toContain("Policy Guidance");
		});

		test("no policy inject text with unmatched layer", () => {
			const nodes = makeNodes("backend");
			const result = resolveVerificationContext("task-1", nodes, testPolicies);
			expect(result).toBeDefined();
			expect(result).not.toContain("Policy Guidance");
		});

		test("no policy inject text without policies", () => {
			const nodes = makeNodes("frontend");
			const result = resolveVerificationContext("task-1", nodes);
			expect(result).toBeDefined();
			expect(result).not.toContain("Policy Guidance");
		});

		test("policy inject text appears after gate requirements", () => {
			const nodes = makeNodes("frontend");
			const result = resolveVerificationContext("task-1", nodes, testPolicies)!;
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
					ref: null,
				}),
			).toBe(true);
		});
	});
});

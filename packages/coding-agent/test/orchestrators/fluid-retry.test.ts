import { describe, expect, test } from "bun:test";
import { computeRetryTaskIds } from "../../src/modes/fluid-mode";
import type { TodoPhase } from "../../src/tools/todo-write";

function makePhases(...tasks: Array<{ id: string; blockers?: string[] }>): TodoPhase[] {
	return [
		{
			id: "phase-1",
			name: "test",
			tasks: tasks.map(t => ({
				id: t.id,
				content: `Task ${t.id}`,
				status: "pending" as const,
				blockers: t.blockers,
			})),
		},
	];
}

describe("computeRetryTaskIds", () => {
	test("returns only failed tasks when no dependents exist", () => {
		const phases = makePhases({ id: "t-1" }, { id: "t-2" }, { id: "t-3" });
		const result = computeRetryTaskIds(phases, new Set(["t-2"]));
		expect(result).toEqual(new Set(["t-2"]));
	});

	test("includes direct dependents of failed tasks", () => {
		const phases = makePhases({ id: "t-1" }, { id: "t-2", blockers: ["t-1"] }, { id: "t-3" });
		const result = computeRetryTaskIds(phases, new Set(["t-1"]));
		expect(result).toEqual(new Set(["t-1", "t-2"]));
	});

	test("includes transitive dependents", () => {
		const phases = makePhases(
			{ id: "t-1" },
			{ id: "t-2", blockers: ["t-1"] },
			{ id: "t-3", blockers: ["t-2"] },
			{ id: "t-4" },
		);
		const result = computeRetryTaskIds(phases, new Set(["t-1"]));
		expect(result).toEqual(new Set(["t-1", "t-2", "t-3"]));
	});

	test("handles diamond dependency pattern", () => {
		// t-1 -> t-2 -> t-4
		// t-1 -> t-3 -> t-4
		const phases = makePhases(
			{ id: "t-1" },
			{ id: "t-2", blockers: ["t-1"] },
			{ id: "t-3", blockers: ["t-1"] },
			{ id: "t-4", blockers: ["t-2", "t-3"] },
		);
		const result = computeRetryTaskIds(phases, new Set(["t-1"]));
		expect(result).toEqual(new Set(["t-1", "t-2", "t-3", "t-4"]));
	});

	test("does not include tasks unrelated to failure", () => {
		const phases = makePhases(
			{ id: "t-1" },
			{ id: "t-2", blockers: ["t-1"] },
			{ id: "t-3" },
			{ id: "t-4", blockers: ["t-3"] },
		);
		// Only t-1 failed; t-3 and t-4 are on a separate dependency chain
		const result = computeRetryTaskIds(phases, new Set(["t-1"]));
		expect(result).toEqual(new Set(["t-1", "t-2"]));
	});

	test("handles multiple failed roots", () => {
		const phases = makePhases(
			{ id: "t-1" },
			{ id: "t-2" },
			{ id: "t-3", blockers: ["t-1"] },
			{ id: "t-4", blockers: ["t-2"] },
		);
		const result = computeRetryTaskIds(phases, new Set(["t-1", "t-2"]));
		expect(result).toEqual(new Set(["t-1", "t-2", "t-3", "t-4"]));
	});
});

import { describe, expect, test } from "bun:test";

import {
	computeWaveLayers,
	fluidPlanToTodoGroups,
	type PlanWave,
	planWavesToTodoGroups,
} from "../../src/orchestrators/fluid/plan-to-todos";

import type { FluidPlan } from "../../src/orchestrators/fluid/types";

describe("planWavesToTodoGroups", () => {
	test("maps extracted plan waves without inventing implicit cross-wave blockers", () => {
		const waves: PlanWave[] = [
			{
				name: "foundation",
				entries: [{ id: "FEAT-001::define-types", orgItemId: "FEAT-001", step: "Define interfaces" }],
			},
			{
				name: "verify",
				entries: [
					{ id: "FEAT-001::write-tests", orgItemId: "FEAT-001", step: "Write tests" },
					{ id: "FEAT-002::smoke", orgItemId: "FEAT-002", step: "Run smoke checks" },
				],
			},
		];

		const groups = planWavesToTodoGroups(waves);
		expect(groups.map(group => group.name)).toEqual(["foundation", "verify"]);
		expect(groups[0]).toMatchObject({ id: "group-1", name: "foundation" });
		expect(groups[0]?.tasks[0]).toMatchObject({
			id: "task-1",
			content: "Define interfaces",
			status: "in_progress",
			orgItemId: "FEAT-001",
		});
		expect(groups[0]?.tasks[0]?.orgItemClosingId).toBeUndefined();
		expect(groups[1]?.tasks.map(task => task.blockers)).toEqual([undefined, undefined]);
		expect(groups[1]?.tasks[0]?.orgItemClosingId).toBe("FEAT-001");
		expect(groups[1]?.tasks[1]?.orgItemClosingId).toBe("FEAT-002");
	});
});

describe("fluidPlanToTodoGroups", () => {
	test("derives canonical waves from a plain FluidPlan with precise blockers", () => {
		const plan: FluidPlan = {
			agents: [
				{
					id: "root",
					task: "Gather data",
					dependsOn: [],
					orgItemId: "FEAT-001",
					effort: "S",
					priority: "A",
					body: "Inspect the target module.",
				},
				{ id: "parallel-a", task: "Analyze A", dependsOn: ["root"] },
				{ id: "parallel-b", task: "Analyze B", dependsOn: ["root"] },
				{ id: "merge", task: "Merge outputs", dependsOn: ["parallel-a", "parallel-b"] },
			],
		};

		const waves = computeWaveLayers(plan);
		expect(waves.map(wave => wave.name)).toEqual(["wave-1", "wave-2", "wave-3"]);
		expect(waves[0]?.entries[0]).toMatchObject({
			id: "root",
			orgItemId: "FEAT-001",
			step: "Gather data",
		});

		const groups = fluidPlanToTodoGroups(plan);
		expect(groups.map(group => group.name)).toEqual(["wave-1", "wave-2", "wave-3"]);
		expect(groups[0]?.tasks[0]).toMatchObject({
			content: "Gather data",
			status: "in_progress",
			orgItemId: "FEAT-001",
			orgItemClosingId: "FEAT-001",
		});
		expect(groups[0]?.tasks[0]?.details).toContain("Effort: S");
		expect(groups[0]?.tasks[0]?.details).toContain("Priority: A");
		expect(groups[0]?.tasks[0]?.details).toContain("Inspect the target module.");
		expect(groups[1]?.tasks.map(task => task.blockers)).toEqual([["task-1"], ["task-1"]]);
		expect(groups[2]?.tasks[0]?.blockers).toEqual(["task-2", "task-3"]);
	});

	test("splits disconnected components and skips fully deferred waves", () => {
		const plan: FluidPlan = {
			agents: [
				{ id: "a-1", task: "Component A work", dependsOn: [], orgItemId: "FEAT-101" },
				{ id: "b-1", task: "Deferred work", dependsOn: [], orgItemId: "FEAT-102", deferred: true },
				{ id: "b-2", task: "Active work", dependsOn: ["b-1"], orgItemId: "FEAT-102" },
			],
		};

		const groups = fluidPlanToTodoGroups(plan);
		expect(groups.map(group => group.name)).toEqual(["component-1-wave-1", "component-2-wave-2"]);
		expect(groups[0]?.tasks[0]?.content).toBe("Component A work");
		expect(groups[1]?.tasks[0]).toMatchObject({
			content: "Active work",
			blockers: undefined,
			orgItemClosingId: "FEAT-102",
		});
	});
});

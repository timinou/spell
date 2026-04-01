import { describe, expect, test } from "bun:test";
import type { FluidPlanWithComponents } from "@oh-my-pi/pi-org";
import { fluidPlanToTodoPhases } from "../../src/orchestrators/fluid/plan-to-todos";
import type { FluidPlan } from "../../src/orchestrators/fluid/types";

function makePlan(overrides: Partial<FluidPlanWithComponents> = {}): FluidPlanWithComponents {
	return {
		components: overrides.components ?? [],
		warnings: overrides.warnings ?? [],
	};
}

describe("fluidPlanToTodoPhases", () => {
	test("maps a single-component single-wave plan into one phase", () => {
		const plan = makePlan({
			components: [
				{
					id: "component-1",
					agents: [
						{
							id: "analyze",
							task: "Analyze code",
							dependsOn: [],
							orgItemId: "FEAT-001",
							effort: "S",
							priority: "A",
							state: "ITEM",
							body: "Inspect the target module.",
						},
					],
					waves: [{ number: 1, items: ["analyze"] }],
				},
			],
		});

		const phases = fluidPlanToTodoPhases(plan);
		expect(phases).toHaveLength(1);
		expect(phases[0]).toMatchObject({ id: "phase-1", name: "wave-1" });
		expect(phases[0].tasks).toHaveLength(1);
		expect(phases[0].tasks[0]).toMatchObject({
			id: "task-1",
			content: "Analyze code",
			status: "in_progress",
			orgItemId: "FEAT-001",
			orgItemClosingId: "FEAT-001",
		});
		expect(phases[0].tasks[0]?.details).toContain("Effort: S");
		expect(phases[0].tasks[0]?.details).toContain("Priority: A");
		expect(phases[0].tasks[0]?.details).toContain("Inspect the target module.");
	});

	test("maps blockers to generated task ids across waves", () => {
		const plan = makePlan({
			components: [
				{
					id: "component-1",
					agents: [
						{
							id: "root",
							task: "Root task",
							dependsOn: [],
							orgItemId: "FEAT-001",
							effort: "S",
							priority: "A",
							state: "ITEM",
							body: "",
						},
						{
							id: "child-a",
							task: "Child A",
							dependsOn: ["root"],
							orgItemId: "FEAT-001",
							effort: "M",
							priority: "B",
							state: "ITEM",
							body: "",
						},
						{
							id: "child-b",
							task: "Child B",
							dependsOn: ["root"],
							orgItemId: "FEAT-002",
							effort: "M",
							priority: "B",
							state: "ITEM",
							body: "",
						},
					],
					waves: [
						{ number: 1, items: ["root"] },
						{ number: 2, items: ["child-a", "child-b"] },
					],
				},
			],
		});

		const phases = fluidPlanToTodoPhases(plan);
		expect(phases.map(phase => phase.name)).toEqual(["wave-1", "wave-2"]);
		expect(phases[1]?.tasks.map(task => task.blockers)).toEqual([["task-1"], ["task-1"]]);
		expect(phases[1]?.tasks[0]?.orgItemClosingId).toBe("FEAT-001");
		expect(phases[1]?.tasks[1]?.orgItemClosingId).toBe("FEAT-002");
	});

	test("creates phases per component and skips empty deferred waves", () => {
		const plan = makePlan({
			components: [
				{
					id: "component-a",
					agents: [
						{
							id: "a-1",
							task: "Component A work",
							dependsOn: [],
							orgItemId: "FEAT-101",
							effort: "S",
							priority: "A",
							state: "ITEM",
							body: "",
						},
					],
					waves: [{ number: 1, items: ["a-1"] }],
				},
				{
					id: "component-b",
					agents: [
						{
							id: "b-1",
							task: "Deferred work",
							dependsOn: [],
							orgItemId: "FEAT-102",
							effort: "S",
							priority: "B",
							state: "ITEM",
							body: "",
							deferred: true,
						},
						{
							id: "b-2",
							task: "Active work",
							dependsOn: [],
							orgItemId: "FEAT-102",
							effort: "M",
							priority: "B",
							state: "ITEM",
							body: "",
						},
					],
					waves: [
						{ number: 1, items: ["b-1"] },
						{ number: 2, items: ["b-2"] },
					],
				},
			],
		});

		const phases = fluidPlanToTodoPhases(plan);
		expect(phases.map(phase => phase.name)).toEqual(["component-a-wave-1", "component-b-wave-2"]);
		expect(phases[1]?.tasks).toHaveLength(1);
		expect(phases[1]?.tasks[0]?.content).toBe("Active work");
	});

	test("supports plain FluidPlan input for canvas mode", () => {
		const plan: FluidPlan = {
			agents: [
				{ id: "root", task: "Gather data", dependsOn: [] },
				{ id: "parallel-a", task: "Analyze A", dependsOn: ["root"] },
				{ id: "parallel-b", task: "Analyze B", dependsOn: ["root"] },
				{ id: "merge", task: "Merge outputs", dependsOn: ["parallel-a", "parallel-b"] },
			],
		};

		const phases = fluidPlanToTodoPhases(plan);
		expect(phases.map(phase => phase.name)).toEqual(["wave-1", "wave-2", "wave-3"]);
		expect(phases[0]?.tasks[0]).toMatchObject({ content: "Gather data", status: "in_progress" });
		expect(phases[1]?.tasks.map(task => task.blockers)).toEqual([["task-1"], ["task-1"]]);
		expect(phases[2]?.tasks[0]?.blockers).toEqual(["task-2", "task-3"]);
		expect(phases.flatMap(phase => phase.tasks).every(task => task.orgItemId === undefined)).toBe(true);
	});
});

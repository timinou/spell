import { describe, expect, it } from "bun:test";
import type { PlanWave } from "../../src/orchestrators/fluid/plan-to-todos";
import { planWavesToTodoPhases } from "../../src/orchestrators/fluid/plan-to-todos";

describe("wave layer resolution", () => {
	it("carries layer from PlanWaveEntry to TodoItem", () => {
		const waves: PlanWave[] = [
			{
				name: "wave-1",
				entries: [
					{ id: "FEAT-001", orgItemId: "FEAT-001", step: "Build UI", layer: "frontend" },
					{ id: "FEAT-002", orgItemId: "FEAT-002", step: "Build API", layer: "api" },
				],
			},
		];

		const phases = planWavesToTodoPhases(waves);
		expect(phases[0]?.tasks[0]?.layer).toBe("frontend");
		expect(phases[0]?.tasks[1]?.layer).toBe("api");
	});

	it("leaves TodoItem layer undefined when entry has no layer", () => {
		const waves: PlanWave[] = [
			{
				name: "wave-1",
				entries: [{ id: "FEAT-003", orgItemId: "FEAT-003", step: "Migrate DB" }],
			},
		];

		const phases = planWavesToTodoPhases(waves);
		expect(phases[0]?.tasks[0]?.layer).toBeUndefined();
	});
});

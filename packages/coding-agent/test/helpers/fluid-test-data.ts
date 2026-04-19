import type { FluidPlan } from "../../src/orchestrators/fluid/types";
import type { SingleResult } from "../../src/task/types";

export const SIMPLE_PLAN: FluidPlan = {
	agents: [
		{ id: "analyze", task: "Analyze the code", dependsOn: [] },
		{ id: "fix", task: "Fix issues", dependsOn: ["analyze"] },
	],
};

export const PARALLEL_PLAN: FluidPlan = {
	agents: [
		{ id: "root", task: "Gather data", dependsOn: [] },
		{ id: "branch-a", task: "Process A", dependsOn: ["root"] },
		{ id: "branch-b", task: "Process B", dependsOn: ["root"] },
		{ id: "merge", task: "Merge results", dependsOn: ["branch-a", "branch-b"] },
	],
};

export function mockResult(id: string, output = ""): SingleResult {
	return {
		index: 0,
		id,
		agent: "test",
		agentSource: "bundled",
		task: "test",
		exitCode: 0,
		outcome: "completed",
		stderr: "",
		resultUri: `agent://${id}`,
		textPreview: output,
		durationMs: 100,
		tokens: 10,
	};
}

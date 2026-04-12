import { describe, expect, it } from "bun:test";
import { renderPromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import eagerTodoPrompt from "@oh-my-pi/pi-coding-agent/prompts/system/eager-todo.md" with { type: "text" };
import planModeApprovedPrompt from "@oh-my-pi/pi-coding-agent/prompts/system/plan-mode-approved.md" with {
	type: "text",
};
import taskPrompt from "@oh-my-pi/pi-coding-agent/prompts/tools/task.md" with { type: "text" };
import todoWritePrompt from "@oh-my-pi/pi-coding-agent/prompts/tools/todo-write.md" with { type: "text" };

describe("auto-roster prompt wiring", () => {
	it("renders task prompt with auto-roster guidance when enabled", () => {
		const rendered = renderPromptTemplate(taskPrompt, {
			autoRosterEnabled: true,
			asyncEnabled: false,
			agents: [],
		});

		expect(rendered).toContain("`phase`: Optional phase name for the auto-created roster phase");
		expect(rendered).toContain("`.blockers`: Optional task IDs within this batch");
		expect(rendered).toContain("Task dispatch auto-creates todo roster entries");
	});

	it("renders legacy task guidance when auto-roster is disabled", () => {
		const rendered = renderPromptTemplate(taskPrompt, {
			autoRosterEnabled: false,
			asyncEnabled: false,
			agents: [],
		});

		expect(rendered).toContain("Auto-roster is disabled in this session.");
		expect(rendered).not.toContain("Task dispatch auto-creates todo roster entries");
	});

	it("renders plan-mode approval prompt with unified task dispatch when auto-roster is enabled", () => {
		const rendered = renderPromptTemplate(planModeApprovedPrompt, {
			planContent: "1. Do work",
			finalPlanFilePath: "org://PLAN-005-test",
			orgItemId: "PLAN-005-test",
			orgItemArtifactsDir: "!tasks/plans/plan-artifacts/PLAN-005-test",
			tools: ["todo_write"],
			autoInitialized: false,
			waves: true,
			autoRosterEnabled: true,
		});

		expect(rendered).toContain("### Wave-based Task Dispatch");
		expect(rendered).toContain("Set `phase` to the wave name");
		expect(rendered).not.toContain(
			"Before execution, you **MUST** initialize todo tracking for this plan with `todo_write`.",
		);
		expect(rendered).not.toContain("set `todoRef` on the task to the todo item's ID");
	});

	it("renders eager-todo reminder without forcing upfront todo_write when auto-roster is enabled", () => {
		const rendered = renderPromptTemplate(eagerTodoPrompt, { autoRosterEnabled: true });

		expect(rendered).toContain("You **MAY** let the `task` tool auto-create roster entries");
		expect(rendered).not.toContain("You **MUST** call `todo_write` first in this turn.");
	});

	it("documents todo_write coexistence with auto-created roster items", () => {
		const rendered = renderPromptTemplate(todoWritePrompt, { autoRosterEnabled: true });

		expect(rendered).toContain("Task dispatches may auto-create groups and delegated items in this same roster.");
		expect(rendered).toContain("Auto-created items behave the same as manual ones once they exist.");
	});
});

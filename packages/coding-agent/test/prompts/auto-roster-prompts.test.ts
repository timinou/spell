import { describe, expect, it } from "bun:test";
import { renderPromptTemplate } from "@spell/pi-coding-agent/config/prompt-templates";
import eagerTodoPrompt from "../../src/prompts/system/eager-todo.md" with { type: "text" };
import taskPrompt from "../../src/prompts/tools/task.md" with { type: "text" };
import todoWritePrompt from "../../src/prompts/tools/todo-write.md" with { type: "text" };

describe("auto-roster prompt wiring", () => {
	it("renders task prompt with auto-roster guidance when enabled", () => {
		const rendered = renderPromptTemplate(taskPrompt, {
			autoRosterEnabled: true,
			asyncEnabled: false,
			agents: [],
		});

		expect(rendered).toContain("roster group name for the auto-created todos");
		expect(rendered).toContain("blockers");
		expect(rendered).toContain("Dispatch auto-creates roster todos");
	});

	it("renders legacy task guidance when auto-roster is disabled", () => {
		const rendered = renderPromptTemplate(taskPrompt, {
			autoRosterEnabled: false,
			asyncEnabled: false,
			agents: [],
		});

		expect(rendered).toContain("Auto-roster off.");
		expect(rendered).not.toContain("Dispatch auto-creates roster todos");
	});

	it("renders eager-todo reminder without forcing upfront todo_write when auto-roster is enabled", () => {
		const rendered = renderPromptTemplate(eagerTodoPrompt, { autoRosterEnabled: true });

		expect(rendered).toContain("You MAY let `task` auto-create roster nodes");
		expect(rendered).not.toContain("You **MUST** call `todo_write` first in this turn.");
	});

	it("documents todo_write coexistence with auto-created roster items", () => {
		const rendered = renderPromptTemplate(todoWritePrompt, { autoRosterEnabled: true });

		expect(rendered).toContain("`task` dispatch may auto-create roster nodes");
		expect(rendered).toContain("Auto-created nodes behave like manual ones");
	});
});

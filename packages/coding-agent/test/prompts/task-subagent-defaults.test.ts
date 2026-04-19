import { describe, expect, it } from "bun:test";
import quickTaskPrompt from "../../src/prompts/agents/quick_task.md" with { type: "text" };
import taskPrompt from "../../src/prompts/agents/task.md" with { type: "text" };
import { loadBundledAgents } from "../../src/task/agents";

describe("task subagent defaults", () => {
	it("bundled task prompt prefers direct work before delegation", () => {
		expect(taskPrompt).toContain("Default: do the work directly.");
		expect(taskPrompt).toContain("Delegate only when the task is clearly justified");
	});

	it("bundled quick_task prompt treats scope restriction as optional config", () => {
		expect(quickTaskPrompt).toContain("Scope restriction is configured by frontmatter when needed");
		expect(quickTaskPrompt).toContain("not an unconditional bundled default");
	});

	it("bundled quick_task is no longer scope restricted by default", () => {
		const quickTask = loadBundledAgents().find(agent => agent.name === "quick_task");
		expect(quickTask?.scopeRestricted).toBeUndefined();
	});
});

import { describe, expect, it } from "bun:test";
import quickTaskPrompt from "../../src/prompts/agents/quick_task.md" with { type: "text" };
import taskPrompt from "../../src/prompts/agents/task.md" with { type: "text" };
import { loadBundledAgents } from "../../src/task/agents";

describe("task subagent defaults", () => {
	it("bundled task prompt makes delegation scope-conditional, not swarm-by-default (kill-list D1)", () => {
		expect(taskPrompt).toContain("atomic → direct");
		expect(taskPrompt).toContain("multi-file/multi-concern → delegate");
		// Old swarm-by-default phrasing must not resurface.
		expect(taskPrompt).not.toContain("do the work directly");
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

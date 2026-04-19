import { afterEach, describe, expect, test } from "bun:test";
import { clearBundledAgentsCache, loadBundledAgents } from "../../src/task/agents";

afterEach(() => {
	clearBundledAgentsCache();
});

describe("bundled agent tool grants", () => {
	test("task agent has unrestricted tools (undefined)", () => {
		const task = loadBundledAgents().find(a => a.name === "task");
		// task has no explicit tool list — unrestricted access includes todo_write
		expect(task).toBeDefined();
		expect(task?.tools).toBeUndefined();
	});

	test("quick_task agent has an explicit narrow tool list", () => {
		const quickTask = loadBundledAgents().find(a => a.name === "quick_task");
		expect(quickTask).toBeDefined();
		expect(quickTask?.tools).toBeDefined();
	});

	test("quick_task tool list does not include todo_write", () => {
		const quickTask = loadBundledAgents().find(a => a.name === "quick_task");
		expect(quickTask?.tools).not.toContain("todo_write");
	});

	test("quick_task tool list includes submit_result", () => {
		const quickTask = loadBundledAgents().find(a => a.name === "quick_task");
		expect(quickTask?.tools).toContain("submit_result");
	});

	test("quick_task prompt stays narrow and omits todo_write planning", () => {
		const quickTask = loadBundledAgents().find(a => a.name === "quick_task");
		expect(quickTask?.systemPrompt).toContain("intentionally narrow and mechanical");
		expect(quickTask?.systemPrompt).not.toContain("FULL access to all tools");
		expect(quickTask?.systemPrompt).not.toContain("todo_write");
		expect(quickTask?.systemPrompt).not.toContain("Delegate");
	});

	test("task prompt keeps todo_write planning guidance", () => {
		const task = loadBundledAgents().find(a => a.name === "task");
		expect(task?.systemPrompt).toContain("create sniper todos via `todo_write`");
	});

	test("quick_task roster is false", () => {
		const quickTask = loadBundledAgents().find(a => a.name === "quick_task");
		expect(quickTask?.roster).toBe(false);
	});

	test("all bundled agents are parseable", () => {
		const agents = loadBundledAgents();
		expect(agents.length).toBeGreaterThan(0);
		for (const agent of agents) {
			expect(agent.name).toBeTruthy();
			expect(agent.description).toBeTruthy();
		}
	});
});

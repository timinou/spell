import { afterEach, describe, expect, test } from "bun:test";
import { clearBundledAgentsCache, loadBundledAgents } from "../../src/task/agents";
import { parseAgentFields } from "../../src/discovery/helpers";

afterEach(() => {
	clearBundledAgentsCache();
});

describe("quick_task scope guardrails", () => {
	test("quick_task is the only scopeRestricted bundled agent", () => {
		const agents = loadBundledAgents();
		const scoped = agents.filter(agent => agent.scopeRestricted === true).map(agent => agent.name);
		expect(scoped).toEqual(["quick_task"]);
	});

	test("quick_task frontmatter parses scopeRestricted true", () => {
		const agent = loadBundledAgents().find(entry => entry.name === "quick_task");
		expect(agent?.scopeRestricted).toBe(true);
	});

	test("parseAgentFields preserves explicit scopeRestricted flag", () => {
		const parsed = parseAgentFields({ name: "demo", description: "demo", scopeRestricted: true });
		expect(parsed?.scopeRestricted).toBe(true);
	});
});

import { describe, expect, test } from "bun:test";
import { parseAgentFields } from "../../src/discovery/helpers";

describe("parseAgentFields – todo_write implicit grant", () => {
	test("injects todo_write into explicit tool list for normal subagents", () => {
		const fields = parseAgentFields({
			name: "task",
			description: "desc",
			tools: ["read", "grep"],
		});

		expect(fields?.tools).toContain("todo_write");
	});

	test("does not duplicate todo_write when already present", () => {
		const fields = parseAgentFields({
			name: "task",
			description: "desc",
			tools: ["read", "todo_write"],
		});

		const count = fields?.tools?.filter(t => t === "todo_write").length;
		expect(count).toBe(1);
	});

	test("does not inject todo_write for quick_task", () => {
		const fields = parseAgentFields({
			name: "quick_task",
			description: "desc",
			tools: ["read", "grep", "edit"],
		});

		expect(fields?.tools).not.toContain("todo_write");
	});

	test("still injects submit_result for quick_task", () => {
		const fields = parseAgentFields({
			name: "quick_task",
			description: "desc",
			tools: ["read", "grep"],
		});

		expect(fields?.tools).toContain("submit_result");
	});

	test("leaves tools undefined when no explicit tool list is given", () => {
		const fields = parseAgentFields({
			name: "task",
			description: "desc",
		});

		expect(fields?.tools).toBeUndefined();
	});

	test("lowercases tools before injection checks", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			tools: ["Read", "Grep"],
		});

		expect(fields?.tools).toContain("todo_write");
		expect(fields?.tools).toContain("submit_result");
		expect(fields?.tools).toContain("read");
		expect(fields?.tools).toContain("grep");
	});
});

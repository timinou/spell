import { afterEach, describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { parseAgentFields } from "../../src/discovery/helpers";
import { clearBundledAgentsCache, loadBundledAgents } from "../../src/task/agents";
import { taskItemSchema, taskSchemaNoIsolation } from "../../src/task/types";

afterEach(() => {
	clearBundledAgentsCache();
});

describe("task schema extensions", () => {
	const baseTask = {
		id: "inspectFile",
		description: "Inspect file",
		assignment: "## Target\n- File: foo.ts",
		ref: null,
	};

	test("taskItemSchema accepts blockers", () => {
		expect(
			Value.Check(taskItemSchema, {
				...baseTask,
				blockers: ["buildSchema"],
			}),
		).toBe(true);
	});

	test("taskItemSchema remains backward compatible without blockers", () => {
		expect(Value.Check(taskItemSchema, baseTask)).toBe(true);
	});

	test("task schema accepts optional phase", () => {
		expect(
			Value.Check(taskSchemaNoIsolation, {
				agent: "task",
				phase: "Investigation",
				tasks: [baseTask],
			}),
		).toBe(true);
	});

	test("parseAgentFields parses roster false", () => {
		const fields = parseAgentFields({
			name: "quick_task",
			description: "desc",
			roster: false,
		});

		expect(fields?.roster).toBe(false);
	});

	test("parseAgentFields leaves roster undefined when omitted", () => {
		const fields = parseAgentFields({
			name: "task",
			description: "desc",
		});

		expect(fields?.roster).toBeUndefined();
	});

	test("bundled quick_task agent defaults roster false", () => {
		const quickTask = loadBundledAgents().find(agent => agent.name === "quick_task");
		expect(quickTask?.roster).toBe(false);
	});
});

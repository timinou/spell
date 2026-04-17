import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { OrgTool } from "@oh-my-pi/pi-coding-agent/tools/org";
import { sanitizeText } from "@oh-my-pi/pi-natives";
import { Value } from "@sinclair/typebox/value";

function createSession(): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionId: () => "test-session",
		getFirstUserMessage: () => "Improve org labels",
		settings: Settings.isolated(),
	};
}

describe("OrgTool", () => {
	it("renders operation-specific call labels with query details", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const tool = new OrgTool(createSession());

		const queryComponent = tool.renderCall(
			{
				command: "query",
				query: "todo:DOING\ttags:auth",
				ql: '(effort >= "2h")',
				category: "plans",
				includeBody: true,
			},
			{ expanded: false, isPartial: false },
			uiTheme,
		);
		const queryOutput = sanitizeText(queryComponent.render(120).join("\n")).replace(/\s+/g, " ");
		expect(queryOutput).toContain("Org");
		expect(queryOutput).toContain("query");
		expect(queryOutput).toContain("query:todo:DOING tags:auth");
		expect(queryOutput).toContain('ql:(effort >= "2h")');
		expect(queryOutput).toContain("category:plans");
		expect(queryOutput).toContain("includeBody:true");
		expect(queryOutput).not.toContain("\t");

		const updateComponent = tool.renderCall(
			{
				command: "update",
				id: "ITEM-123-example",
				state: "DONE",
				note: "closed after verification",
				append: "Verification complete",
			},
			{ expanded: false, isPartial: false },
			uiTheme,
		);
		const updateOutput = sanitizeText(updateComponent.render(120).join("\n")).replace(/\s+/g, " ");
		expect(updateOutput).toContain("update");
		expect(updateOutput).toContain("id:ITEM-123-example");
		expect(updateOutput).toContain("state:DONE");
		expect(updateOutput).toContain("note");
		expect(updateOutput).toContain("append");

		await tool.dispose();
	});

	it("renders compact wave and graph call labels", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const tool = new OrgTool(createSession());

		const waveComponent = tool.renderCall(
			{ command: "wave", dir: "/org/waves" },
			{ expanded: false, isPartial: false },
			uiTheme,
		);
		const waveOutput = sanitizeText(waveComponent.render(120).join("\n")).replace(/\s+/g, " ");
		expect(waveOutput).toContain("wave");
		expect(waveOutput).toContain("dir:/org/waves");

		const graphComponent = tool.renderCall(
			{ command: "graph", dir: "/org/graph" },
			{ expanded: false, isPartial: false },
			uiTheme,
		);
		const graphOutput = sanitizeText(graphComponent.render(120).join("\n")).replace(/\s+/g, " ");
		expect(graphOutput).toContain("graph");
		expect(graphOutput).toContain("dir:/org/graph");

		await tool.dispose();
	});

	it("renders delete and validate-plan call labels with id details", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const tool = new OrgTool(createSession());

		const deleteComponent = tool.renderCall(
			{ command: "delete", id: "FEAT-001" },
			{ expanded: false, isPartial: false },
			uiTheme,
		);
		const deleteOutput = sanitizeText(deleteComponent.render(120).join("\n")).replace(/\s+/g, " ");
		expect(deleteOutput).toContain("delete");
		expect(deleteOutput).toContain("id:FEAT-001");

		const validatePlanComponent = tool.renderCall(
			{ command: "validate-plan", id: "PLAN-001" },
			{ expanded: false, isPartial: false },
			uiTheme,
		);
		const validatePlanOutput = sanitizeText(validatePlanComponent.render(120).join("\n")).replace(/\s+/g, " ");
		expect(validatePlanOutput).toContain("validate-plan");
		expect(validatePlanOutput).toContain("id:PLAN-001");

		await tool.dispose();
	});

	it("declares query and ql in the adapter schema", async () => {
		const tool = new OrgTool(createSession());
		const schema = tool.parameters as {
			properties?: Record<string, unknown>;
		};

		expect(schema.properties).toBeDefined();
		expect(schema.properties).toHaveProperty("query");
		expect(schema.properties).toHaveProperty("ql");
		expect(
			Value.Check(tool.parameters, {
				command: "query",
				query: "todo:DOING tags:auth",
				ql: '(todo "DOING")',
			}),
		).toBe(true);

		await tool.dispose();
	});
});

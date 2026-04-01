import { describe, expect, it } from "bun:test";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { taskToolRenderer } from "../../src/task/render";
import type { TaskToolDetails } from "../../src/task/types";

describe("taskToolRenderer report_finding safety", () => {
	it("renders progress without crashing when report_finding payload is malformed", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 42,
			progress: [
				{
					index: 0,
					id: "1-Reviewer",
					agent: "reviewer",
					agentSource: "bundled",
					status: "running",
					task: "Review patch",
					recentTools: [],
					recentOutput: [],
					toolCount: 1,
					tokens: 0,
					durationMs: 42,
					extractedToolData: {
						report_finding: [{}],
					},
				},
			],
		};

		const rendered = taskToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details,
			},
			{ expanded: false, isPartial: true },
			uiTheme,
		);

		expect(() => rendered.render(120)).not.toThrow();
	});

	it("renders abort reason inline for aborted subagent results", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [
				{
					index: 0,
					id: "1-Reviewer",
					agent: "reviewer",
					agentSource: "bundled",
					task: "Review patch",
					exitCode: 1,
					output: "",
					stderr: "",
					truncated: false,
					durationMs: 42,
					tokens: 0,
					aborted: true,
					abortReason: "blocked by permissions",
				},
			],
			totalDurationMs: 42,
		};

		const rendered = taskToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details,
			},
			{ expanded: false, isPartial: false },
			uiTheme,
		);

		const lines = rendered.render(120);
		expect(lines.join("\n")).toContain("blocked by permissions");
	});
	it("renders retry status for running subagent progress", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 42,
			progress: [
				{
					index: 0,
					id: "1-TaskWorker",
					agent: "task",
					agentSource: "bundled",
					status: "running",
					task: "Wait for quota reset",
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					tokens: 0,
					durationMs: 42,
					retry: {
						attempt: 1,
						maxAttempts: 3,
						delayMs: 1_800_000,
						errorMessage: "usage limit reached",
					},
				},
			],
		};

		const rendered = taskToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details,
			},
			{ expanded: false, isPartial: true },
			uiTheme,
		);

		const output = rendered.render(120).join("\n");
		expect(output).toContain("Retrying (1/3)");
		expect(output).toContain("usage limit reached");
	});
});

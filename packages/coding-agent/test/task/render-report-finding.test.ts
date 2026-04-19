import { describe, expect, it } from "bun:test";
import { INTENT_FIELD } from "@oh-my-pi/pi-agent-core";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { EventController } from "../../src/modes/controllers/event-controller";
import { taskToolRenderer } from "../../src/task/render";
import type { TaskToolDetails } from "../../src/task/types";
import { formatBytes } from "../../src/tools/render-utils";

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
		expect(lines.join("\n")).toContain("1 aborted");
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
	it("renders task call previews with zero agents when tasks are not streamed yet", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const renderedCall = taskToolRenderer.renderCall(
			{ agent: "task" } as never,
			{ expanded: false, isPartial: true },
			uiTheme,
		);

		expect(renderedCall.render(120).join("\n")).toContain("0 agents");
	});

	it("renders context previews with zero agents when tasks are not streamed yet", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const renderedCall = taskToolRenderer.renderCall(
			{ agent: "task", context: "## Goal\nStreamed preview" } as never,
			{ expanded: false, isPartial: true },
			uiTheme,
		);

		const output = renderedCall.render(120).join("\n");
		expect(output).toContain("Context");
		expect(output).toContain("0 agents");
	});

	it("renders efficiency summaries for completed multi-task batches", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [
				{
					index: 0,
					id: "task-a",
					agent: "task",
					agentSource: "bundled",
					task: "Inspect A",
					exitCode: 0,
					output: "",
					stderr: "",
					truncated: false,
					durationMs: 120,
					tokens: 100,
				},
				{
					index: 1,
					id: "task-b",
					agent: "task",
					agentSource: "bundled",
					task: "Inspect B",
					exitCode: 0,
					output: "",
					stderr: "",
					truncated: false,
					durationMs: 80,
					tokens: 80,
				},
			],
			totalDurationMs: 50,
			usage: {
				input: 120,
				output: 60,
				cacheRead: 120,
				cacheWrite: 0,
				totalTokens: 300,
				cost: { input: 0.12, output: 0.06, cacheRead: 0.02, cacheWrite: 0, total: 0.2 },
			},
		};

		const rendered = taskToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: true, isPartial: false },
			uiTheme,
		);

		const output = rendered.render(140).join("\n");
		expect(output).toContain("Efficiency:");
		expect(output).toContain("180 tokens");
		expect(output).toContain("$0.200");
		expect(output).toContain("50ms");
	});

	it("omits efficiency summary for single-task batches", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [
				{
					index: 0,
					id: "task-a",
					agent: "task",
					agentSource: "bundled",
					task: "Inspect A",
					exitCode: 0,
					output: "",
					stderr: "",
					truncated: false,
					durationMs: 120,
					tokens: 100,
				},
			],
			totalDurationMs: 120,
		};

		const rendered = taskToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: false, isPartial: false },
			uiTheme,
		);

		expect(rendered.render(140).join("\n")).not.toContain("Efficiency:");
	});
});

describe("EventController streamed task working message", () => {
	it("shows byte-progress fallback until intent is available", async () => {
		const setMessages: string[] = [];
		const pendingTool = {
			updateArgs: () => {},
		};
		const pendingTools = new Map<string, typeof pendingTool>([["tool-1", pendingTool]]);
		const ctx = {
			isInitialized: true,
			init: async () => {},
			statusLine: { invalidate: () => {}, setCanvasTaskCount: () => {} },
			updateEditorTopBorder: () => {},
			streamingComponent: { updateContent: () => {} },
			streamingMessage: undefined,
			pendingTools,
			ui: { requestRender: () => {} },
			setWorkingMessage: (message?: string) => {
				if (message) setMessages.push(message);
			},
		} as unknown as ConstructorParameters<typeof EventController>[0];

		const controller = new EventController(ctx);
		const partialJson = '{"task":"é"}';
		const bytes = Buffer.byteLength(partialJson, "utf8");

		await controller.handleEvent({
			type: "message_update",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tool-1",
						name: "task",
						arguments: {},
						partialJson,
					},
				],
			},
		} as never);
		expect(setMessages.at(-1)).toBe(`task args ${formatBytes(bytes)} (esc to interrupt)`);

		await controller.handleEvent({
			type: "message_update",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tool-1",
						name: "task",
						arguments: { [INTENT_FIELD]: "Summarizing streamed args" },
						partialJson,
					},
				],
			},
		} as never);
		expect(setMessages.at(-1)).toBe("Summarizing streamed args (esc to interrupt)");

		await controller.handleEvent({
			type: "message_update",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tool-1",
						name: "task",
						arguments: {},
						partialJson: '{"task":"é","extra":"δ"}',
					},
				],
			},
		} as never);
		expect(setMessages.at(-1)).toBe("Summarizing streamed args (esc to interrupt)");
	});
});

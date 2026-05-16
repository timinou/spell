import { describe, expect, it } from "bun:test";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { renderResult } from "../../src/task/render";
import type { AgentProgress, TaskToolDetails } from "../../src/task/types";

const baseProgress = (overrides: Partial<AgentProgress> = {}): AgentProgress => ({
	index: 0,
	id: "1-Worker",
	agent: "worker",
	agentSource: "bundled",
	status: "running",
	task: "Doing slow work",
	recentTools: [],
	recentOutput: [],
	toolCount: 0,
	tokens: 0,
	durationMs: 100,
	...overrides,
});

describe("taskToolRenderer renderResult cache key", () => {
	it("re-renders when progress content changes under identical render options", async () => {
		const theme = (await getThemeByName("dark"))!;
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 100,
			progress: [baseProgress()],
		};

		const component = renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: false, isPartial: true, spinnerFrame: 0 },
			theme,
		);

		const initialLines = component.render(120).slice();

		// Mutate captured progress in-place — same details object reference,
		// same options. Without a content signature in the cache key, the
		// renderer would serve stale `initialLines`.
		details.progress![0] = baseProgress({
			toolCount: 5,
			tokens: 1_234,
			durationMs: 4_500,
			currentTool: "bash",
		});

		const afterLines = component.render(120);

		expect(afterLines).not.toEqual(initialLines);
	});

	it("re-renders when toolCount or tokens advance under identical render options", async () => {
		const theme = (await getThemeByName("dark"))!;
		const progress = baseProgress({ toolCount: 1, tokens: 100 });
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 100,
			progress: [progress],
		};

		const component = renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: false, isPartial: true, spinnerFrame: 0 },
			theme,
		);

		const before = component.render(120).slice();

		progress.toolCount = 7;
		progress.tokens = 2_500;

		const after = component.render(120);

		expect(after).not.toEqual(before);
	});

	it("returns identical output when nothing has changed (cache-friendly)", async () => {
		const theme = (await getThemeByName("dark"))!;
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 100,
			progress: [baseProgress({ toolCount: 3, tokens: 200 })],
		};

		const component = renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: false, isPartial: true, spinnerFrame: 0 },
			theme,
		);

		const a = component.render(120);
		const b = component.render(120);

		expect(b).toEqual(a);
	});
});

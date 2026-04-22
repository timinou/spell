import { describe, expect, it } from "bun:test";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { taskToolRenderer } from "../../src/task/render";
import { SubagentTracker } from "../../src/task/subagent-tracker";
import type { SingleResult, SubagentOutcome, TaskToolDetails } from "../../src/task/types";
import { EventBus } from "../../src/utils/event-bus";

function createResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "task-1",
		agent: "task",
		agentSource: "bundled",
		task: "Inspect repo",
		exitCode: 0,
		outcome: "completed",
		stderr: "",
		resultUri: "agent://task-1",
		durationMs: 25,
		tokens: 10,
		...overrides,
	};
}

async function renderResults(results: SingleResult[]): Promise<string> {
	const theme = await getThemeByName("dark");
	expect(theme).toBeDefined();
	const rendered = taskToolRenderer.renderResult(
		{
			content: [{ type: "text", text: "" }],
			details: { projectAgentsDir: null, results, totalDurationMs: 25 } satisfies TaskToolDetails,
		},
		{ expanded: true, isPartial: false },
		theme!,
	);
	return rendered.render(140).join("\n");
}

describe("task envelope v2 rendering", () => {
	it("renders small structured results inline", async () => {
		const output = await renderResults([createResult({ structuredResult: { ok: true, count: 2 } })]);
		expect(output).toContain('"ok": true');
		expect(output).toContain('"count": 2');
	});

	it("renders large structured results via agent uri", async () => {
		const output = await renderResults([
			createResult({ structuredResult: { payload: "x".repeat(6_000) }, resultUri: "agent://task-large" }),
		]);
		expect(output).toContain("agent://task-large");
		expect(output).not.toContain("payload");
	});

	it("renders child result trees", async () => {
		const output = await renderResults([
			createResult({
				children: [createResult({ id: "child-1", resultUri: "agent://child-1", textPreview: "child done" })],
			}),
		]);
		expect(output).toContain("Children (1)");
		expect(output).toContain("child-1");
		expect(output).toContain("child done");
	});

	it("renders spawn audit for denied spawns", async () => {
		const output = await renderResults([
			createResult({
				outcome: "policy-rejected",
				exitCode: 1,
				error: "Cannot spawn 'oracle'. Allowed: quick_task",
				spawnAudit: {
					requestedAgent: "oracle",
					parentSpawnPolicy: "quick_task",
					allowedAgents: ["quick_task"],
					granted: false,
					reason: "policy-rejected",
				},
			}),
		]);
		expect(output).toContain("policy-rejected");
		expect(output).toContain("spawn oracle");
	});

	it("treats completed-empty as success in rendering", async () => {
		const output = await renderResults([createResult({ outcome: "completed-empty" })]);
		expect(output).toContain("completed-empty");
	});
});

describe("task envelope v2 tracker", () => {
	function record(outcome: SubagentOutcome): SubagentTracker {
		const tracker = new SubagentTracker(new EventBus(), () => {});
		tracker.recordCompletion(createResult({ outcome, exitCode: outcome === "failed" ? 1 : 0 }));
		return tracker;
	}

	it("counts completed-empty as completed", () => {
		const tracker = record("completed-empty");
		expect(tracker.getLifetimeStats().totalCompleted).toBe(1);
	});

	it("counts cancelled as aborted", () => {
		const tracker = record("cancelled");
		expect(tracker.getLifetimeStats().totalAborted).toBe(1);
	});

	it("counts policy rejections as failures", () => {
		const tracker = record("policy-rejected");
		expect(tracker.getLifetimeStats().totalFailed).toBe(1);
	});
});

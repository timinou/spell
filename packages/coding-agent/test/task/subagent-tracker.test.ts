import { describe, expect, test } from "bun:test";
import { SubagentTracker } from "../../src/task/subagent-tracker";
import { type AgentProgress, type SingleResult, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../../src/task/types";
import { EventBus } from "../../src/utils/event-bus";

function createProgress(overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id: "task-1",
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "Inspect repo",
		recentTools: [],
		recentOutput: [],
		toolCount: 1,
		tokens: 120,
		durationMs: 250,
		sessionId: "session-1",
		currentTool: "grep",
		lastIntent: "Finding references",
		currentToolStartMs: 1_000,
		usage: { cost: 0.12 },
		...overrides,
	};
}

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
		textPreview: "done",
		durationMs: 500,
		tokens: 120,
		sessionId: "session-1",
		usage: {
			input: 100,
			output: 20,
			cacheRead: 50,
			cacheWrite: 0,
			totalTokens: 170,
			cost: { input: 0.03, output: 0.01, cacheRead: 0.005, cacheWrite: 0, total: 0.045 },
		},
		...overrides,
	};
}

async function waitForTracker(): Promise<void> {
	await Bun.sleep(125);
}

describe("SubagentTracker", () => {
	test("tracks active progress and session lookups", async () => {
		const bus = new EventBus();
		let changes = 0;
		const tracker = new SubagentTracker(bus, () => {
			changes += 1;
		});

		const progress = createProgress();
		bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: progress.index,
			agent: progress.agent,
			agentSource: progress.agentSource,
			task: progress.task,
			progress,
		});
		await waitForTracker();

		expect(tracker.getInfo()).toMatchObject({
			runningCount: 1,
			pendingCount: 0,
			totalCost: 0.12,
			mostActiveAgent: {
				id: "task-1",
				currentTool: "grep",
				lastIntent: "Finding references",
			},
		});
		expect(tracker.getActivityForSession("session-1")?.currentTool).toBe("grep");
		expect(changes).toBe(1);
	});

	test("prefers the most recently active running agent", async () => {
		const bus = new EventBus();
		const tracker = new SubagentTracker(bus, () => {});

		const slower = createProgress({
			id: "task-a",
			sessionId: "session-a",
			currentToolStartMs: 1_000,
			currentTool: "read",
		});
		const newer = createProgress({
			id: "task-b",
			sessionId: "session-b",
			currentToolStartMs: 2_000,
			currentTool: "edit",
			lastIntent: "Updating UI",
		});
		for (const progress of [slower, newer]) {
			bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
				index: progress.index,
				agent: progress.agent,
				agentSource: progress.agentSource,
				task: progress.task,
				progress,
			});
		}
		await waitForTracker();

		expect(tracker.getInfo().mostActiveAgent).toMatchObject({
			id: "task-b",
			currentTool: "edit",
			lastIntent: "Updating UI",
		});
	});

	test("records lifetime stats once per completion", async () => {
		const bus = new EventBus();
		const tracker = new SubagentTracker(bus, () => {});
		const progress = createProgress();
		bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: progress.index,
			agent: progress.agent,
			agentSource: progress.agentSource,
			task: progress.task,
			progress,
		});
		await waitForTracker();

		tracker.recordCompletion(createResult());
		tracker.recordCompletion(createResult());

		const stats = tracker.getLifetimeStats();
		expect(stats.totalLaunched).toBe(1);
		expect(stats.totalCompleted).toBe(1);
		expect(stats.totalFailed).toBe(0);
		expect(stats.totalAborted).toBe(0);
		expect(stats.totalTokens).toBe(170);
		expect(stats.totalCost).toBeCloseTo(0.045, 6);
		expect(stats.avgTokensPerSubtask).toBe(170);
		expect(stats.cacheHitRate).toBeCloseTo(50 / 150, 6);
		expect(stats.byAgentType.get("task")).toEqual({ count: 1, tokens: 170, cost: 0.045 });
		expect(tracker.getActivityForSession("session-1")).toBeUndefined();
	});

	test("stops reacting after dispose", async () => {
		const bus = new EventBus();
		let changes = 0;
		const tracker = new SubagentTracker(bus, () => {
			changes += 1;
		});
		tracker.dispose();

		const progress = createProgress();
		bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: progress.index,
			agent: progress.agent,
			agentSource: progress.agentSource,
			task: progress.task,
			progress,
		});
		await waitForTracker();

		expect(changes).toBe(0);
		expect(tracker.getInfo().runningCount).toBe(0);
	});
});

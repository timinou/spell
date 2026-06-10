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

describe("SubagentTracker ask dialogue (PLAN-327)", () => {
	test("aggregates raised → answered into the dialogue + openAskCount", () => {
		const bus = new EventBus();
		const tracker = new SubagentTracker(bus, () => {});

		bus.emit("task:ask:raised", {
			runId: "r",
			questionId: "r:ask-1",
			fromTaskId: "task-1",
			question: "which error type?",
			blocking: true,
		});
		expect(tracker.getInfo().openAskCount).toBe(1);
		expect(tracker.getPendingAsksForTask("task-1").length).toBe(1);

		bus.emit("task:ask:answered", {
			runId: "r",
			questionId: "r:ask-1",
			answer: "AppError",
			recipients: ["task-1", "task-3"],
		});
		expect(tracker.getInfo().openAskCount).toBe(0);
		const dialogue = tracker.getAskDialogue();
		expect(dialogue.length).toBe(1);
		expect(dialogue[0]?.status).toBe("answered");
		expect(dialogue[0]?.answer).toBe("AppError");
		expect(dialogue[0]?.recipients).toContain("task-3");
		tracker.dispose();
	});

	test("cancelled ask resolves to answered with no-answer marker", () => {
		const bus = new EventBus();
		const tracker = new SubagentTracker(bus, () => {});
		bus.emit("task:ask:raised", {
			runId: "r",
			questionId: "r:ask-1",
			fromTaskId: "task-1",
			question: "q",
			blocking: true,
		});
		bus.emit("task:ask:cancelled", { runId: "r", questionId: "r:ask-1", reason: "batch complete" });
		expect(tracker.getInfo().openAskCount).toBe(0);
		expect(tracker.getAskDialogue()[0]?.status).toBe("answered");
		tracker.dispose();
	});

	test("answered for unknown questionId is ignored (no phantom entry)", () => {
		const bus = new EventBus();
		const tracker = new SubagentTracker(bus, () => {});
		bus.emit("task:ask:answered", { runId: "r", questionId: "ghost", answer: "x", recipients: [] });
		bus.emit("task:ask:cancelled", { runId: "r", questionId: "ghost", reason: "x" });
		expect(tracker.getAskDialogue().length).toBe(0);
		expect(tracker.getInfo().openAskCount).toBe(0);
		tracker.dispose();
	});

	test("after dispose, ask events no longer mutate the dialogue", () => {
		const bus = new EventBus();
		const tracker = new SubagentTracker(bus, () => {});
		tracker.dispose();
		bus.emit("task:ask:raised", {
			runId: "r",
			questionId: "r:ask-1",
			fromTaskId: "task-1",
			question: "q",
			blocking: true,
		});
		expect(tracker.getAskDialogue().length).toBe(0);
	});
});

/**
 * TDD tests for the canvas _tier: "task" dispatch channel.
 *
 * Uses a fake executor instead of real subprocess spawning.
 * Contracts tested:
 * - CANVAS_TASK_CHANNEL routes events to CanvasTaskManager
 * - Manager calls executor with correct agent definition, assignment, model, tools, schema
 * - Result is sent back to the originating window via bridge.sendMessage
 * - Window close aborts the running task
 * - Duplicate window requests abort the previous task
 * - Dispose cleans up everything
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type CanvasTaskExecutor, CanvasTaskManager } from "../../src/orchestrators/canvas-task-manager";
import type { SingleResult } from "../../src/task/types";
import {
	CANVAS_EVENTS_CHANNEL,
	CANVAS_TASK_CHANNEL,
	type CanvasTaskPayload,
	type CanvasWindowEventsPayload,
} from "../../src/tools/canvas";
import { EventBus, Priority } from "../../src/utils/event-bus";

// ---------------------------------------------------------------------------
// Fake executor
// ---------------------------------------------------------------------------

interface FakeCall {
	id: string;
	assignment: string;
	agent: { name: string; systemPrompt?: string; tools?: string[]; model?: string[] };
	outputSchema?: unknown;
	signal: AbortSignal;
	resolve: (output: string) => void;
	reject: (err: Error) => void;
}

function createFakeExecutor() {
	const calls: FakeCall[] = [];

	const executor: CanvasTaskExecutor = options => {
		const { promise, resolve, reject } = Promise.withResolvers<SingleResult>();
		const stubResult = (output: string): SingleResult => ({
			index: options.index,
			id: options.id,
			agent: options.agent.name,
			agentSource: "bundled",
			task: options.task,
			assignment: options.assignment,
			exitCode: 0,
			output,
			stderr: "",
			truncated: false,
			durationMs: 0,
			tokens: 0,
		});
		calls.push({
			id: options.id,
			assignment: options.assignment ?? "",
			agent: {
				name: options.agent.name,
				systemPrompt: options.agent.systemPrompt,
				tools: options.agent.tools,
				model: options.agent.model,
			},
			outputSchema: options.outputSchema,
			signal: options.signal!,
			resolve: (output: string) => resolve(stubResult(output)),
			reject,
		});
		return promise;
	};

	return { calls, executor };
}

// ---------------------------------------------------------------------------
// Fake bridge
// ---------------------------------------------------------------------------

function createFakeBridge() {
	const sent: Array<{ windowId: string; payload: Record<string, unknown> }> = [];
	return {
		sent,
		sendMessage(id: string, payload: Record<string, unknown>) {
			sent.push({ windowId: id, payload });
		},
	};
}

/** Drain EventBus and yield to let fire-and-forget handlers settle. */
async function drainAndSettle(eventBus: EventBus) {
	await eventBus.drain();
	// The task handler is fire-and-forget; yield so the async body runs.
	await Bun.sleep(5);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CANVAS_TASK_CHANNEL", () => {
	it("is a distinct non-empty string", () => {
		expect(CANVAS_TASK_CHANNEL).toBe("canvas:task:request");
	});
});

describe("CanvasTaskManager", () => {
	let eventBus: EventBus;
	let bridge: ReturnType<typeof createFakeBridge>;
	let fake: ReturnType<typeof createFakeExecutor>;
	let manager: CanvasTaskManager;

	function emit(payload: CanvasTaskPayload) {
		eventBus.enqueue(CANVAS_TASK_CHANNEL, payload, Priority.P1);
	}

	function emitClose(windowId: string) {
		const p: CanvasWindowEventsPayload = {
			windowId,
			events: [{ name: "close", payload: { action: "close" } }],
			closed: true,
			silent: false,
		};
		eventBus.emit(CANVAS_EVENTS_CHANNEL, p);
	}

	beforeEach(() => {
		eventBus = new EventBus();
		bridge = createFakeBridge();
		fake = createFakeExecutor();
		manager = new CanvasTaskManager({
			eventBus,
			cwd: "/tmp/test-cwd",
			executor: fake.executor,
		});
		manager.setBridge(bridge as any);
		manager.start();
	});

	afterEach(() => {
		manager.dispose();
	});

	it("spawns executor with correct assignment and default model", async () => {
		emit({ windowId: "w1", assignment: "Fix the button spacing" });
		await drainAndSettle(eventBus);

		expect(fake.calls).toHaveLength(1);
		const call = fake.calls[0];
		expect(call.assignment).toContain("Fix the button spacing");
		expect(call.agent.model).toEqual(["pi/smol"]);
		expect(call.agent.name).toBe("canvas-task");
	});

	it("forwards custom model, tools, systemPrompt, and outputSchema", async () => {
		const schema = { properties: { summary: { type: "string" } } };
		emit({
			windowId: "w2",
			assignment: "Refactor layout",
			model: "pi/opus",
			systemPrompt: "You are a CSS expert.",
			tools: ["read", "edit"],
			outputSchema: schema,
		});
		await drainAndSettle(eventBus);

		expect(fake.calls).toHaveLength(1);
		const call = fake.calls[0];
		expect(call.agent.model).toEqual(["pi/opus"]);
		expect(call.agent.systemPrompt).toBe("You are a CSS expert.");
		expect(call.agent.tools).toEqual(["read", "edit"]);
		expect(call.outputSchema).toEqual(schema);
	});

	it("sends result back to originating window on completion", async () => {
		emit({ windowId: "w3", assignment: "Fix it" });
		await drainAndSettle(eventBus);

		fake.calls[0].resolve("Changed 2 files.");
		await Bun.sleep(10);

		expect(bridge.sent).toHaveLength(1);
		expect(bridge.sent[0].windowId).toBe("w3");
		expect(bridge.sent[0].payload.action).toBe("task_result");
		expect(bridge.sent[0].payload.output).toBe("Changed 2 files.");
		expect(bridge.sent[0].payload.ok).toBe(true);
	});

	it("sends error back to window on executor failure", async () => {
		emit({ windowId: "w4", assignment: "Break things" });
		await drainAndSettle(eventBus);

		fake.calls[0].reject(new Error("Model unavailable"));
		await Bun.sleep(10);

		expect(bridge.sent).toHaveLength(1);
		expect(bridge.sent[0].windowId).toBe("w4");
		expect(bridge.sent[0].payload.ok).toBe(false);
		expect(bridge.sent[0].payload.error).toBe("Model unavailable");
	});

	it("aborts running task when window closes", async () => {
		emit({ windowId: "w5", assignment: "Long task" });
		await drainAndSettle(eventBus);

		expect(fake.calls[0].signal.aborted).toBe(false);
		emitClose("w5");
		expect(fake.calls[0].signal.aborted).toBe(true);
		expect(manager.getActive().find(a => a.windowId === "w5")).toBeUndefined();
	});

	it("aborts previous task when same window sends a new one", async () => {
		emit({ windowId: "w6", assignment: "Task A" });
		await drainAndSettle(eventBus);

		const firstSignal = fake.calls[0].signal;
		expect(firstSignal.aborted).toBe(false);

		emit({ windowId: "w6", assignment: "Task B" });
		await drainAndSettle(eventBus);

		expect(firstSignal.aborted).toBe(true);
		expect(fake.calls).toHaveLength(2);
		expect(fake.calls[1].signal.aborted).toBe(false);
		expect(fake.calls[1].assignment).toContain("Task B");
	});

	it("tracks active tasks via getActive()", async () => {
		expect(manager.getActive()).toEqual([]);

		emit({ windowId: "w7", assignment: "Active task" });
		await drainAndSettle(eventBus);

		const active = manager.getActive();
		expect(active).toHaveLength(1);
		expect(active[0].windowId).toBe("w7");
		expect(active[0].assignment).toBe("Active task");

		fake.calls[0].resolve("done");
		await Bun.sleep(10);

		expect(manager.getActive()).toEqual([]);
	});

	it("dispose aborts all active tasks", async () => {
		emit({ windowId: "w8", assignment: "Task 1" });
		emit({ windowId: "w9", assignment: "Task 2" });
		await drainAndSettle(eventBus);

		manager.dispose();

		expect(fake.calls[0].signal.aborted).toBe(true);
		expect(fake.calls[1].signal.aborted).toBe(true);
		expect(manager.getActive()).toEqual([]);
	});

	it("does not send success result if window was already closed", async () => {
		emit({ windowId: "w10", assignment: "Task" });
		await drainAndSettle(eventBus);

		emitClose("w10");
		fake.calls[0].resolve("late result");
		await Bun.sleep(10);

		const successMessages = bridge.sent.filter(m => m.windowId === "w10" && m.payload.ok === true);
		expect(successMessages).toHaveLength(0);
	});

	it("appends context and image count to assignment text", async () => {
		emit({
			windowId: "w11",
			assignment: "Fix it",
			context: { selector: ".btn" },
			images: [{ data: "iVBOR...", mimeType: "image/png" }],
		});
		await drainAndSettle(eventBus);

		const call = fake.calls[0];
		expect(call.assignment).toContain("Fix it");
		expect(call.assignment).toContain("Context:");
		expect(call.assignment).toContain("1 screenshot(s) attached");
	});
});

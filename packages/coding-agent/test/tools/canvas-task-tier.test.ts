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
 * - Task submissions acknowledge QML immediately and time out cleanly
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { QmlBridge } from "@spell/pi-qml";
import { type CanvasTaskExecutor, CanvasTaskManager } from "../../src/orchestrators/canvas-task-manager";
import { type AgentProgress, type SingleResult, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../../src/task/types";
import {
	CANVAS_EVENTS_CHANNEL,
	CANVAS_TASK_CHANNEL,
	type CanvasTaskPayload,
	type CanvasWindowEventsPayload,
} from "../../src/tools/canvas";
import { EventBus, Priority } from "../../src/utils/event-bus";

interface FakeCall {
	id: string;
	assignment: string;
	agent: { name: string; systemPrompt?: string; tools?: string[]; model?: string[] };
	outputSchema?: unknown;
	signal: AbortSignal;
	resolve: (output: string) => void;
	reject: (err: Error) => void;
}

interface FakeExecutorState {
	calls: FakeCall[];
	executor: CanvasTaskExecutor;
}

interface BridgeMessage {
	windowId: string;
	payload: Record<string, unknown>;
}

interface FakeBridge {
	sent: BridgeMessage[];
	sendMessage(id: string, payload: Record<string, unknown>): void;
}

function createFakeExecutor(): FakeExecutorState {
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
			outcome: "completed",
			stderr: "",
			resultUri: `agent://${options.id}`,
			textPreview: output,
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

function createAbortAwareExecutor(onCall?: (signal: AbortSignal) => void): CanvasTaskExecutor {
	return options => {
		onCall?.(options.signal!);
		const { promise, reject } = Promise.withResolvers<SingleResult>();
		options.signal?.addEventListener(
			"abort",
			() => {
				reject(
					options.signal?.reason instanceof Error
						? options.signal.reason
						: new Error(String(options.signal?.reason)),
				);
			},
			{ once: true },
		);
		return promise;
	};
}

function createFakeBridge(): FakeBridge {
	const sent: BridgeMessage[] = [];
	return {
		sent,
		sendMessage(id: string, payload: Record<string, unknown>) {
			sent.push({ windowId: id, payload });
		},
	};
}

async function drainAndSettle(eventBus: EventBus) {
	await eventBus.drain();
	await Bun.sleep(5);
}

describe("CANVAS_TASK_CHANNEL", () => {
	it("is a distinct non-empty string", () => {
		expect(CANVAS_TASK_CHANNEL).toBe("canvas:task:request");
	});
});

describe("CanvasTaskManager", () => {
	let eventBus: EventBus;
	let bridge: FakeBridge;
	let fake: FakeExecutorState;
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

	function recreateManager(executor: CanvasTaskExecutor, timeoutMs?: number) {
		manager.dispose();
		manager = new CanvasTaskManager({
			eventBus,
			cwd: "/tmp/test-cwd",
			executor,
			timeoutMs,
		});
		manager.setBridge(bridge as unknown as QmlBridge);
		manager.start();
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
		manager.setBridge(bridge as unknown as QmlBridge);
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
		expect(call.agent.model).toEqual(["pi/sniper"]);
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

	it("calls reply callback with ack before executing", async () => {
		const ordering: string[] = [];
		recreateManager(_options => {
			ordering.push("executor");
			const { promise } = Promise.withResolvers<SingleResult>();
			return promise;
		});

		const replies: Record<string, unknown>[] = [];
		emit({
			windowId: "w-ack",
			assignment: "Fix the dialog layout",
			reply: result => {
				ordering.push("reply");
				replies.push(result);
			},
		});
		await drainAndSettle(eventBus);

		expect(replies).toHaveLength(1);
		expect(replies[0]).toMatchObject({
			action: "task_ack",
			ok: true,
			status: "processing",
			model: "pi/sniper",
		});
		expect(String(replies[0].message)).toContain("Task received:");
		expect(ordering).toEqual(["reply", "executor"]);
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
		expect(bridge.sent[0].payload.model).toBe("pi/sniper");
		expect(bridge.sent[0].payload.tokens).toBe(0);
		expect(typeof bridge.sent[0].payload.durationMs).toBe("number");
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
		expect(bridge.sent[0].payload.model).toBe("pi/sniper");
		expect(bridge.sent[0].payload.retryable).toBe(true);
		expect(typeof bridge.sent[0].payload.durationMs).toBe("number");
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

	it("includes model in result for custom model requests", async () => {
		emit({ windowId: "w-model-result", assignment: "Fix it", model: "pi/slow" });
		await drainAndSettle(eventBus);

		fake.calls[0].resolve("Done.");
		await Bun.sleep(10);

		expect(bridge.sent[0].payload.model).toBe("pi/slow");
		expect(bridge.sent[0].payload.ok).toBe(true);
	});

	it("forwards progress events to the originating window", async () => {
		emit({ windowId: "w-progress", assignment: "Build thing" });
		await drainAndSettle(eventBus);

		const taskId = fake.calls[0].id;
		const progress: AgentProgress = {
			index: 0,
			id: taskId,
			agent: "canvas-task",
			agentSource: "bundled",
			status: "running",
			task: "Build thing",
			assignment: "Build thing",
			currentTool: "edit",
			lastIntent: "Fixing layout",
			recentTools: [],
			recentOutput: [],
			toolCount: 3,
			tokens: 1500,
			durationMs: 4200,
		};

		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: 0,
			agent: "canvas-task",
			agentSource: "bundled",
			task: "Build thing",
			assignment: "Build thing",
			progress,
		});

		expect(bridge.sent).toHaveLength(1);
		expect(bridge.sent[0].windowId).toBe("w-progress");
		expect(bridge.sent[0].payload).toMatchObject({
			action: "task_progress",
			status: "running",
			currentTool: "edit",
			toolCount: 3,
		});
	});

	it("ignores progress events for unknown tasks", () => {
		const progress: AgentProgress = {
			index: 0,
			id: "canvas-task-nonexistent-123",
			agent: "canvas-task",
			agentSource: "bundled",
			status: "running",
			task: "unknown",
			assignment: "unknown",
			currentTool: "read",
			recentTools: [],
			recentOutput: [],
			toolCount: 1,
			tokens: 100,
			durationMs: 500,
		};

		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: 0,
			agent: "canvas-task",
			agentSource: "bundled",
			task: "unknown",
			assignment: "unknown",
			progress,
		});

		expect(bridge.sent).toHaveLength(0);
	});

	it("aborts executor signal when task exceeds configured timeout", async () => {
		let timeoutSignal: AbortSignal | undefined;
		recreateManager(
			createAbortAwareExecutor(signal => {
				timeoutSignal = signal;
			}),
			20,
		);

		emit({ windowId: "w-timeout-signal", assignment: "Wait forever" });
		await drainAndSettle(eventBus);
		await Bun.sleep(40);

		expect(timeoutSignal).toBeDefined();
		expect(timeoutSignal?.aborted).toBe(true);
	});

	it("sends timeout error to QML when task exceeds limit", async () => {
		recreateManager(createAbortAwareExecutor(), 20);

		emit({ windowId: "w-timeout", assignment: "Wait forever" });
		await drainAndSettle(eventBus);
		await Bun.sleep(40);

		expect(bridge.sent).toHaveLength(1);
		expect(bridge.sent[0].windowId).toBe("w-timeout");
		expect(bridge.sent[0].payload).toMatchObject({
			action: "task_result",
			ok: false,
			timedOut: true,
			error: "Task timed out after 0.02s",
			model: "pi/sniper",
			retryable: true,
		});
	});
});

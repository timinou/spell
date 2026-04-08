/**
 * Regression tests for BUG-190: todo auto-clear must not remove a completed task
 * that is still referenced by another task's `blockers` list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel, type ToolResultMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { TodoPhase } from "@oh-my-pi/pi-coding-agent/tools/todo-write";
import { TempDir } from "@oh-my-pi/pi-utils";

class MockAssistantStream extends AssistantMessageEventStream {}

function makeSession(
	tempDir: TempDir,
	authStorage: AuthStorage,
	delayMs: number,
	sessionManager = SessionManager.inMemory(tempDir.path()),
): AgentSession {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model");

	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"todo.enabled": true,
		"tasks.todoClearDelay": delayMs / 1000,
	});

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "Test",
			tools: [],
			messages: [],
		},
		streamFn: () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "done" }],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "mock",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					},
				});
			});
			return stream;
		},
	});

	return new AgentSession({ agent, sessionManager, settings, modelRegistry, toolRegistry: new Map() });
}

describe("AgentSession todo auto-clear blocker awareness", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;

	beforeEach(async () => {
		vi.useFakeTimers();
		tempDir = TempDir.createSync("@pi-agent-session-todo-auto-clear-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = makeSession(tempDir, authStorage, 1000);
	});

	afterEach(async () => {
		vi.useRealTimers();
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	it("clears an unreferenced completed task after the delay", () => {
		const phases: TodoPhase[] = [
			{
				id: "phase-1",
				name: "Phase 1",
				tasks: [{ id: "task-a", content: "Do A", status: "completed" }],
			},
		];
		session.setTodoPhases(phases);

		// Still present before delay elapses
		expect(session.getTodoPhases()[0]?.tasks).toHaveLength(1);

		vi.advanceTimersByTime(1100);

		// Should have been cleared
		expect(session.getTodoPhases()).toHaveLength(0);
	});

	it("does NOT clear a completed task that is still referenced via blockers", () => {
		const phases: TodoPhase[] = [
			{
				id: "phase-1",
				name: "Phase 1",
				tasks: [
					{ id: "task-a", content: "Do A", status: "completed" },
					{ id: "task-b", content: "Do B", status: "pending", blockers: ["task-a"] },
				],
			},
		];
		session.setTodoPhases(phases);

		vi.advanceTimersByTime(5000);

		// task-a must remain because task-b still lists it as a blocker
		const tasks = session.getTodoPhases()[0]?.tasks ?? [];
		expect(tasks.some(t => t.id === "task-a")).toBe(true);
	});

	it("clears a previously-referenced completed task once the referencing task is removed", () => {
		const phases: TodoPhase[] = [
			{
				id: "phase-1",
				name: "Phase 1",
				tasks: [
					{ id: "task-a", content: "Do A", status: "completed" },
					{ id: "task-b", content: "Do B", status: "pending", blockers: ["task-a"] },
				],
			},
		];
		session.setTodoPhases(phases);
		vi.advanceTimersByTime(5000);
		// task-a still present (referenced)
		expect(session.getTodoPhases()[0]?.tasks.some(t => t.id === "task-a")).toBe(true);

		// Remove task-b (the referencing task)
		const updatedPhases: TodoPhase[] = [
			{
				id: "phase-1",
				name: "Phase 1",
				tasks: [{ id: "task-a", content: "Do A", status: "completed" }],
			},
		];
		session.setTodoPhases(updatedPhases);

		// Now task-a has no referencing tasks — timer should be scheduled
		vi.advanceTimersByTime(1100);

		expect(session.getTodoPhases()).toHaveLength(0);
	});

	it("cascades auto-clear once a referenced completed task becomes unreferenced", () => {
		const phases: TodoPhase[] = [
			{
				id: "phase-1",
				name: "Phase 1",
				tasks: [
					{ id: "task-a", content: "Do A", status: "completed" },
					{ id: "task-b", content: "Do B", status: "completed", blockers: ["task-a"] },
				],
			},
		];
		session.setTodoPhases(phases);

		vi.advanceTimersByTime(1100);

		const tasks = session.getTodoPhases()[0]?.tasks ?? [];
		expect(tasks.some(t => t.id === "task-b")).toBe(false);
		expect(tasks.some(t => t.id === "task-a")).toBe(true);

		vi.advanceTimersByTime(1100);

		expect(session.getTodoPhases()).toHaveLength(0);
	});

	it("keeps a completed task referenced by an abandoned task", () => {
		// Even abandoned tasks' blocker references count, to preserve audit visibility.
		const phases: TodoPhase[] = [
			{
				id: "phase-1",
				name: "Phase 1",
				tasks: [
					{ id: "task-a", content: "Do A", status: "completed" },
					{ id: "task-b", content: "Do B", status: "abandoned", blockers: ["task-a"] },
				],
			},
		];
		session.setTodoPhases(phases);

		vi.advanceTimersByTime(5000);

		const tasks = session.getTodoPhases()[0]?.tasks ?? [];
		expect(tasks.some(t => t.id === "task-a")).toBe(true);
	});

	it("still clears completed tasks that have no references, even when other tasks are referenced", () => {
		const phases: TodoPhase[] = [
			{
				id: "phase-1",
				name: "Phase 1",
				tasks: [
					{ id: "task-a", content: "Do A", status: "completed" },
					{ id: "task-b", content: "Do B", status: "completed" },
					{ id: "task-c", content: "Do C", status: "pending", blockers: ["task-b"] },
				],
			},
		];
		session.setTodoPhases(phases);

		vi.advanceTimersByTime(1100);

		const tasks = session.getTodoPhases()[0]?.tasks ?? [];
		// task-a had no references → cleared
		expect(tasks.some(t => t.id === "task-a")).toBe(false);
		// task-b is referenced by task-c → preserved
		expect(tasks.some(t => t.id === "task-b")).toBe(true);
		// task-c (pending) still there
		expect(tasks.some(t => t.id === "task-c")).toBe(true);
	});
	it("preserves referenced completed tasks when syncing phases from branch history", async () => {
		await session.dispose();
		const syncedSessionManager = SessionManager.inMemory(tempDir.path());
		const phases: TodoPhase[] = [
			{
				id: "phase-1",
				name: "Phase 1",
				tasks: [
					{ id: "task-a", content: "Do A", status: "completed" },
					{ id: "task-b", content: "Do B", status: "pending", blockers: ["task-a"] },
				],
			},
		];
		const todoWriteResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "todo_write",
			content: [{ type: "text", text: "ok" }],
			details: { phases },
			isError: false,
			timestamp: Date.now(),
		};
		syncedSessionManager.appendMessage(todoWriteResult);
		session = makeSession(tempDir, authStorage, 1000, syncedSessionManager);

		const tasks = session.getTodoPhases()[0]?.tasks ?? [];
		expect(tasks.map(task => task.id)).toEqual(["task-a", "task-b"]);
	});
});

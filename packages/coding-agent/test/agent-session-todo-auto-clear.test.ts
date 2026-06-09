/**
 * Regression tests for BUG-190: todo auto-clear must not remove a completed task
 * that is still referenced by another task's `blockers` list.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";

import * as path from "node:path";

import { Agent } from "@spell/pi-agent-core";

import { getBundledModel, type ToolResultMessage } from "@spell/pi-ai";

import { AssistantMessageEventStream } from "@spell/pi-ai/utils/event-stream";

import { ModelRegistry } from "@spell/pi-coding-agent/config/model-registry";

import { Settings } from "@spell/pi-coding-agent/config/settings";

import { AgentSession } from "@spell/pi-coding-agent/session/agent-session";

import { AuthStorage } from "@spell/pi-coding-agent/session/auth-storage";

import { SessionManager } from "@spell/pi-coding-agent/session/session-manager";

import type { TodoNode } from "@spell/pi-coding-agent/tools/todo-write";

import { TempDir } from "@spell/pi-utils";

class MockAssistantStream extends AssistantMessageEventStream {}

function makeSession(
	tempDir: TempDir,
	authStorage: AuthStorage,
	delayMs: number,
	sessionManager = SessionManager.inMemory(tempDir.path()),
): AgentSession {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model");

	const modelRegistry = new ModelRegistry(authStorage, undefined, path.join(tempDir.path(), "models.yml"));
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
		const nodes: TodoNode[] = [{ id: "task-a", content: "Do A", status: "completed" }];
		session.setTodoNodes(nodes);

		// Still present before delay elapses
		expect(session.getTodoNodes()).toHaveLength(1);

		vi.advanceTimersByTime(1100);

		// Should have been cleared
		expect(session.getTodoNodes()).toHaveLength(0);
	});

	it("does NOT clear a completed task that is still referenced via blockers", () => {
		const nodes: TodoNode[] = [
			{ id: "task-a", content: "Do A", status: "completed" },
			{ id: "task-b", content: "Do B", status: "pending", blockers: ["task-a"] },
		];
		session.setTodoNodes(nodes);

		vi.advanceTimersByTime(5000);

		// task-a must remain because task-b still lists it as a blocker
		const tasks = session.getTodoNodes();
		expect(tasks.some((task: { id: string }) => task.id === "task-a")).toBe(true);
	});

	it("clears a previously-referenced completed task once the referencing task is removed", () => {
		const nodes: TodoNode[] = [
			{ id: "task-a", content: "Do A", status: "completed" },
			{ id: "task-b", content: "Do B", status: "pending", blockers: ["task-a"] },
		];
		session.setTodoNodes(nodes);
		vi.advanceTimersByTime(5000);
		// task-a still present (referenced)
		expect(session.getTodoNodes().some((task: { id: string }) => task.id === "task-a")).toBe(true);

		// Remove task-b (the referencing task)
		const updatedNodes: TodoNode[] = [{ id: "task-a", content: "Do A", status: "completed" }];
		session.setTodoNodes(updatedNodes);

		// Now task-a has no referencing tasks — timer should be scheduled
		vi.advanceTimersByTime(1100);

		expect(session.getTodoNodes()).toHaveLength(0);
	});

	it("cascades auto-clear once a referenced completed task becomes unreferenced", () => {
		const nodes: TodoNode[] = [
			{ id: "task-a", content: "Do A", status: "completed" },
			{ id: "task-b", content: "Do B", status: "completed", blockers: ["task-a"] },
		];
		session.setTodoNodes(nodes);

		vi.advanceTimersByTime(1100);

		const tasks = session.getTodoNodes();
		expect(tasks.some((task: { id: string }) => task.id === "task-b")).toBe(false);
		expect(tasks.some((task: { id: string }) => task.id === "task-a")).toBe(true);

		vi.advanceTimersByTime(1100);

		expect(session.getTodoNodes()).toHaveLength(0);
	});

	it("keeps a completed task referenced by an abandoned task", () => {
		// Even abandoned tasks' blocker references count, to preserve audit visibility.
		const nodes: TodoNode[] = [
			{ id: "task-a", content: "Do A", status: "completed" },
			{ id: "task-b", content: "Do B", status: "abandoned", blockers: ["task-a"] },
		];
		session.setTodoNodes(nodes);

		vi.advanceTimersByTime(5000);

		const tasks = session.getTodoNodes();
		expect(tasks.some((task: { id: string }) => task.id === "task-a")).toBe(true);
	});

	it("still clears completed tasks that have no references, even when other tasks are referenced", () => {
		const nodes: TodoNode[] = [
			{ id: "task-a", content: "Do A", status: "completed" },
			{ id: "task-b", content: "Do B", status: "completed" },
			{ id: "task-c", content: "Do C", status: "pending", blockers: ["task-b"] },
		];
		session.setTodoNodes(nodes);

		vi.advanceTimersByTime(1100);

		const tasks = session.getTodoNodes();
		// task-a had no references → cleared
		expect(tasks.some((task: { id: string }) => task.id === "task-a")).toBe(false);
		// task-b is referenced by task-c → preserved
		expect(tasks.some((task: { id: string }) => task.id === "task-b")).toBe(true);
		// task-c (pending) still there
		expect(tasks.some((task: { id: string }) => task.id === "task-c")).toBe(true);
	});

	it("preserves referenced completed tasks when syncing phases from branch history", async () => {
		await session.dispose();
		const syncedSessionManager = SessionManager.inMemory(tempDir.path());
		const nodes: TodoNode[] = [
			{ id: "task-a", content: "Do A", status: "completed" },
			{ id: "task-b", content: "Do B", status: "pending", blockers: ["task-a"] },
		];
		const todoWriteResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "todo_write",
			content: [{ type: "text", text: "ok" }],
			details: { nodes },
			isError: false,
			timestamp: Date.now(),
		};
		syncedSessionManager.appendMessage(todoWriteResult);
		session = makeSession(tempDir, authStorage, 1000, syncedSessionManager);

		const tasks = session.getTodoNodes();
		expect(tasks.map((task: { id: string }) => task.id)).toEqual(["task-a", "task-b"]);
	});
});

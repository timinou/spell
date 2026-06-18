import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";

import * as fs from "node:fs";

import * as path from "node:path";

import { Agent } from "@spell/pi-agent-core";

import { getBundledModel } from "@spell/pi-ai/models";

import { ModelRegistry } from "@spell/pi-coding-agent/config/model-registry";

import { Settings } from "@spell/pi-coding-agent/config/settings";

import { loadExtensions } from "@spell/pi-coding-agent/extensibility/extensions/loader";

import { ExtensionRunner } from "@spell/pi-coding-agent/extensibility/extensions/runner";

import { AgentSession } from "@spell/pi-coding-agent/session/agent-session";

import { AuthStorage } from "@spell/pi-coding-agent/session/auth-storage";

import { type CustomEntry, SessionManager } from "@spell/pi-coding-agent/session/session-manager";

import { getProjectAgentDir, TempDir, withTimeout } from "@spell/pi-utils";

const runtimeSignalStoreKey = "__ompRuntimeSignals";

type RuntimeSignalGlobal = typeof globalThis & { [runtimeSignalStoreKey]?: string[] };

function getRuntimeSignals(): string[] {
	const store = globalThis as RuntimeSignalGlobal;
	if (!store[runtimeSignalStoreKey]) store[runtimeSignalStoreKey] = [];
	return store[runtimeSignalStoreKey]!;
}

/**
 * Regression test: auto-compaction completion should resume the agent loop when
 * there are queued agent-level messages (follow-up/steering/custom).
 */

describe("AgentSession auto-compaction queue resume", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-auto-compaction-queue-");
		vi.useFakeTimers();

		const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		const extensionPath = path.join(extensionsDir, "compaction-short-circuit.ts");
		fs.writeFileSync(
			extensionPath,
			[
				"export default function(pi) {",
				'\tpi.on("session_before_compact", async (event) => {',
				"\t\treturn {",
				"\t\t\tcompaction: {",
				'\t\t\t\tsummary: "compacted",',
				"\t\t\t\tshortSummary: undefined,",
				"\t\t\t\tfirstKeptEntryId: event.preparation.firstKeptEntryId,",
				"\t\t\t\ttokensBefore: event.preparation.tokensBefore,",
				"\t\t\t\tdetails: {},",
				"\t\t\t},",
				"\t\t};",
				"\t});",
				'\tpi.on("auto_compaction_start", async (event) => {',
				`\t\tconst signals = globalThis.${runtimeSignalStoreKey} ?? (globalThis.${runtimeSignalStoreKey} = []);`,
				'\t\tsignals.push("compaction:start:" + event.reason);',
				"\t});",
				'\tpi.on("auto_compaction_end", async (event) => {',
				`\t\tconst signals = globalThis.${runtimeSignalStoreKey} ?? (globalThis.${runtimeSignalStoreKey} = []);`,
				'\t\tsignals.push("compaction:end:" + (event.aborted ? "aborted" : "ok"));',
				"\t});",
				"}",
			].join("\n"),
		);

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		getRuntimeSignals().length = 0;

		const extensionsResult = await loadExtensions([extensionPath], tempDir.path());
		const extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		const agent = new Agent({ initialState: { model, systemPrompt: "Test", tools: [], messages: [] } });

		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.autoContinue": false,
				"discipline.yieldReminders": true,
				"discipline.yieldReminders.max": 3,
			}),
			modelRegistry,
			extensionRunner,
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.useRealTimers();
		getRuntimeSignals().length = 0;
		vi.restoreAllMocks();
	});

	it("resumes after threshold compaction when only agent-level queued messages exist", async () => {
		session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "Queued custom" }],
			display: false,
			timestamp: Date.now(),
		});
		expect(session.agent.hasQueuedMessages()).toBe(true);

		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = {
			role: "assistant" as const,
			content: [],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 190000,
				output: 1000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await Promise.resolve();
		const idlePromise = session.waitForIdle();
		let idleResolved = false;
		void idlePromise.then(() => {
			idleResolved = true;
		});
		await Promise.resolve();
		expect(idleResolved).toBe(false);
		vi.advanceTimersByTime(200);
		await idlePromise;

		expect(continueSpy).toHaveBeenCalledTimes(1);
		const runtimeSignals = getRuntimeSignals();
		expect(runtimeSignals).toContain("compaction:start:threshold");
		expect(runtimeSignals.some(signal => signal.startsWith("compaction:end:"))).toBe(true);
	});

	it("re-prompts via the finish-the-loop yield gate when todos are incomplete", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		session.setDisciplines([
			{
				name: "finish-the-loop",
				on: { kind: "auto" },
				guard: "open-work",
				origin: "discipline",
				inject: { cadence: "once", sections: { custom: {}, instructions: "resume unfinished work" } },
			},
		]);
		session.setTodoNodes([
			{ id: "task-1", content: "Finish pending task", status: "in_progress", group: "Execution" },
		]);

		let reminderEvent: Extract<Parameters<Parameters<typeof session.subscribe>[0]>[0], { type: "yield_reminder" }> | undefined;
		const { promise: reminderDone, resolve: onReminderDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "yield_reminder") {
				reminderEvent = event;
				onReminderDone();
			}
		});

		const assistantMsg = {
			role: "assistant" as const,
			content: [],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await withTimeout(reminderDone, 1000, "yield-gate reminder timed out");
		await Promise.resolve();

		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(reminderEvent?.outcomes).toEqual([
			{
				discipline: "finish-the-loop",
				passed: false,
				gate: "open-work",
				incompleteCount: 1,
				reason: "1 incomplete todo item(s) remain",
			},
		]);
		expect(reminderEvent?.stats?.[0]?.activationCount).toBe(1);
		expect(reminderEvent?.stats?.[0]?.lastOutcome?.gate).toBe("open-work");

		const stats = session.getDisciplineStats();
		expect(stats).toHaveLength(1);
		expect(stats[0]?.name).toBe("finish-the-loop");
		expect(stats[0]?.activationCount).toBe(1);
		expect(stats[0]?.gateBreakdown["open-work"]).toBe(1);

		const disciplineEntries = sessionManager
			.getEntries()
			.filter((entry): entry is CustomEntry => entry.type === "custom" && entry.customType === "discipline-event");
		expect(disciplineEntries).toHaveLength(2);
		expect(disciplineEntries.map(entry => (entry.data as { phase?: string } | undefined)?.phase)).toEqual([
			"arm",
			"yield-reminder",
		]);
		expect(sessionManager.buildSessionContext().messages.some(message => message.role === "custom")).toBe(false);
	});
});

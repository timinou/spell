import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@spell/pi-agent-core";
import { type AssistantMessage, getBundledModel } from "@spell/pi-ai";
import { AssistantMessageEventStream } from "@spell/pi-ai/utils/event-stream";
import { ModelRegistry } from "@spell/pi-coding-agent/config/model-registry";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import { AgentSession } from "@spell/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@spell/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@spell/pi-coding-agent/session/session-manager";
import { PendingActionStore } from "@spell/pi-coding-agent/tools/pending-action";
import { Snowflake } from "@spell/pi-utils";

class MockAssistantStream extends AssistantMessageEventStream {}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
	};
}

describe("AgentSession resolve reminder", () => {
	let session: AgentSession;
	let tempDir: string;
	let pendingActionStore: PendingActionStore;
	let streamCallCount = 0;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-resolve-reminder-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		pendingActionStore = new PendingActionStore();
		streamCallCount = 0;

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Test model not found in registry");
		}

		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, undefined, path.join(tempDir, "models.yml"));

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
				messages: [],
			},
			streamFn: () => {
				streamCallCount += 1;
				if (streamCallCount === 1) {
					pendingActionStore.push({
						label: "AST Edit: 1 replacement in 1 file",
						sourceToolName: "edit",
						files: [path.join(tempDir, "preview.ts")],
						apply: async () => ({ content: [{ type: "text", text: "Applied" }] }),
					});
				}
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
				});
				return stream;
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
			pendingActionStore,
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage?.close();
		authStorage = undefined;
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
		vi.restoreAllMocks();
	});

	it("suppresses resolve reminders for auto-apply previews", async () => {
		session.settings.override("edit.previewResolvePolicy", "auto-apply" as never);

		await session.prompt("run preview");

		expect(streamCallCount).toBe(1);
		expect(
			session.agent.state.messages.findIndex(
				message => message.role === "custom" && message.customType === "resolve-reminder",
			),
		).toBe(-1);
		expect(pendingActionStore.hasPending).toBe(true);
	});

	it("forces an immediate steering turn and injects resolve reminder before second assistant response", async () => {
		await session.prompt("run preview");

		expect(streamCallCount).toBe(2);

		const messages = session.agent.state.messages;
		const assistantIndices = messages
			.map((message, index) => (message.role === "assistant" ? index : -1))
			.filter(index => index >= 0);
		const reminderIndex = messages.findIndex(
			message => message.role === "custom" && message.customType === "resolve-reminder",
		);

		expect(assistantIndices.length).toBe(2);
		expect(reminderIndex).toBeGreaterThan(assistantIndices[0]!);
		expect(reminderIndex).toBeLessThan(assistantIndices[1]!);
	});
});

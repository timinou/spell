import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, createToolCallStreamDiagnostic } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-ai/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager, type SessionMessageEntry } from "../src/session/session-manager";
import { formatAssistantToolCallFailureMessage } from "../src/session/tool-call-diagnostics";

function createStallMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "error",
		errorMessage: "Assistant response stalled before any response content arrived. Idle timeout: 10ms.",
		streamDiagnostics: [
			createToolCallStreamDiagnostic({
				state: "stalled_before_response_content",
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				rawPartialJsonBytes: 0,
				idleTimeoutMs: 10,
				providerRetryAttempt: 0,
			}),
		],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
		...overrides,
	};
}

function getPersistedAssistantMessages(session: AgentSession): AssistantMessage[] {
	return session.sessionManager
		.getEntries()
		.filter(
			(entry): entry is SessionMessageEntry & { message: AssistantMessage } =>
				entry.type === "message" && entry.message.role === "assistant",
		)
		.map(entry => entry.message);
}

async function emitAssistantTurn(session: AgentSession, message: AssistantMessage): Promise<void> {
	session.agent.emitExternalEvent({ type: "message_end", message });
	session.agent.emitExternalEvent({ type: "agent_end", messages: [message] });
	await Promise.resolve();
	await Promise.resolve();
}

describe("AgentSession stream stall retry visibility", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-agent-session-stream-stall-retry-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	function createSession(maxRetries: number): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
				messages: [],
			},
		});
		return new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": true,
				"retry.maxRetries": maxRetries,
				"retry.baseDelayMs": 1,
			}),
			modelRegistry,
		});
	}

	it("keeps intermediate stall failures visible and labels them with the retry attempt", async () => {
		const session = createSession(2);
		const events: Array<{ type: string; errorMessage?: string }> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") {
				events.push({ type: event.type, errorMessage: event.errorMessage });
			}
		});

		try {
			const firstFailure = createStallMessage({ timestamp: 1 });
			await emitAssistantTurn(session, firstFailure);

			const assistantMessages = getPersistedAssistantMessages(session);

			expect(assistantMessages).toHaveLength(1);
			expect(formatAssistantToolCallFailureMessage(assistantMessages[0])).toContain("Attempt 1/2 failed; retrying.");
			expect(events).toEqual([
				{
					type: "auto_retry_start",
					errorMessage:
						"Attempt 1/2 failed; retrying. Assistant response stalled before any response content arrived. Idle timeout: 10ms.",
				},
			]);
		} finally {
			await session.dispose();
		}
	});

	it("marks the last visible stall failure as final when retries are exhausted", async () => {
		const session = createSession(1);
		const endEvents: Array<{ attempt: number; finalError?: string }> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end" && !event.success) {
				endEvents.push({ attempt: event.attempt, finalError: event.finalError });
			}
		});

		try {
			await emitAssistantTurn(session, createStallMessage({ timestamp: 1 }));
			await Bun.sleep(20);
			await emitAssistantTurn(session, createStallMessage({ timestamp: 2 }));

			const assistantMessages = getPersistedAssistantMessages(session);
			const finalAssistant = assistantMessages.at(-1);
			if (!finalAssistant) throw new Error("Expected final assistant failure");

			expect(assistantMessages).toHaveLength(2);
			expect(formatAssistantToolCallFailureMessage(finalAssistant)).toContain("Final attempt 1/1 failed.");
			expect(endEvents).toEqual([
				{
					attempt: 1,
					finalError:
						"Final attempt 1/1 failed. Assistant response stalled before any response content arrived. Idle timeout: 10ms.",
				},
			]);
		} finally {
			await session.dispose();
		}
	});
});

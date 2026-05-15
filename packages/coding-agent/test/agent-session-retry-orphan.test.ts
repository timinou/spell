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
import { SessionManager } from "../src/session/session-manager";

function createRetryableErrorMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
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

function createNonRetryableErrorMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "error",
		errorMessage: "Tool foo not found",
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

async function emitAssistantTurn(session: AgentSession, message: AssistantMessage): Promise<void> {
	session.agent.emitExternalEvent({ type: "message_end", message });
	session.agent.emitExternalEvent({ type: "agent_end", messages: [message] });
	await Promise.resolve();
	await Promise.resolve();
}

describe("AgentSession retry orphan resolution", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-agent-session-retry-orphan-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	function createSession(): AgentSession {
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
				"retry.maxRetries": 2,
				"retry.baseDelayMs": 1,
			}),
			modelRegistry,
		});
	}

	it("non-retryable error mid-chain force-ends retry", async () => {
		const session = createSession();
		const events: Array<{ type: string; success?: boolean; finalError?: string }> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start" || event.type === "auto_retry_end") {
				events.push({
					type: event.type,
					success: event.type === "auto_retry_end" ? event.success : undefined,
					finalError: event.type === "auto_retry_end" ? event.finalError : undefined,
				});
			}
		});

		try {
			// Start retry chain with retryable error
			await emitAssistantTurn(session, createRetryableErrorMessage({ timestamp: 1 }));

			// Ensure retry started
			expect(events.some(e => e.type === "auto_retry_start")).toBe(true);

			// Emit non-retryable error during active retry
			await emitAssistantTurn(session, createNonRetryableErrorMessage({ timestamp: 2 }));

			// Assert retry resolves within bounded time
			await Promise.race([
				new Promise<void>((resolve, reject) => {
					const check = setInterval(() => {
						if (!session.isRetrying) {
							clearInterval(check);
							resolve();
						}
					}, 10);
				}),
				Bun.sleep(500).then(() => {
					throw new Error("Timed out waiting for isRetrying to become false");
				}),
			]);

			const endEvent = events.find(e => e.type === "auto_retry_end" && e.success === false);
			expect(endEvent).toBeDefined();
			expect(endEvent?.finalError).toContain("Tool foo not found");

			// waitForIdle should resolve within 1s
			await Promise.race([
				session.waitForIdle(),
				Bun.sleep(1000).then(() => {
					throw new Error("Timed out waiting for waitForIdle");
				}),
			]);
		} finally {
			await session.dispose();
		}
	});

	it("agent_end with no last-assistant message during retry resolves chain", async () => {
		const session = createSession();
		const events: Array<{ type: string; success?: boolean; finalError?: string }> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") {
				events.push({
					type: event.type,
					success: event.success,
					finalError: event.finalError,
				});
			}
		});

		try {
			// Start retry chain
			await emitAssistantTurn(session, createRetryableErrorMessage({ timestamp: 1 }));

			// Emit agent_end with empty messages and no prior message_end
			session.agent.emitExternalEvent({ type: "agent_end", messages: [] });
			await Promise.resolve();
			await Promise.resolve();

			// Assert retry resolves within bounded time
			await Promise.race([
				new Promise<void>((resolve, reject) => {
					const check = setInterval(() => {
						if (!session.isRetrying) {
							clearInterval(check);
							resolve();
						}
					}, 10);
				}),
				Bun.sleep(500).then(() => {
					throw new Error("Timed out waiting for isRetrying to become false");
				}),
			]);

			const endEvent = events.find(e => e.type === "auto_retry_end" && e.success === false);
			expect(endEvent).toBeDefined();
			expect(endEvent?.finalError).toMatch(/interrupted|missing/i);
		} finally {
			await session.dispose();
		}
	});

	it("agent_end with skipPostTurnMaintenance timestamp match resolves chain", async () => {
		const session = createSession();
		const events: Array<{ type: string; success?: boolean; finalError?: string }> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") {
				events.push({
					type: event.type,
					success: event.success,
					finalError: event.finalError,
				});
			}
		});

		try {
			// Start retry chain
			await emitAssistantTurn(session, createRetryableErrorMessage({ timestamp: 1 }));

			// Set skip timestamp for a new message
			const skipTimestamp = 42;
			session.setSkipPostTurnMaintenanceForTimestamp(skipTimestamp);

			// Emit agent_end whose last assistant message has the skip timestamp
			const skipMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "skip me" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "stop",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: skipTimestamp,
			};
			session.agent.emitExternalEvent({ type: "message_end", message: skipMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [skipMessage] });
			await Promise.resolve();
			await Promise.resolve();

			// Assert retry resolves within bounded time
			await Promise.race([
				new Promise<void>((resolve, reject) => {
					const check = setInterval(() => {
						if (!session.isRetrying) {
							clearInterval(check);
							resolve();
						}
					}, 10);
				}),
				Bun.sleep(500).then(() => {
					throw new Error("Timed out waiting for isRetrying to become false");
				}),
			]);

			const endEvent = events.find(e => e.type === "auto_retry_end" && e.success === false);
			expect(endEvent).toBeDefined();
		} finally {
			await session.dispose();
		}
	});

	it("tool-calls present during retry chain still ends chain on non-retryable error", async () => {
		const session = createSession();
		const events: Array<{ type: string; success?: boolean; finalError?: string }> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") {
				events.push({
					type: event.type,
					success: event.success,
					finalError: event.finalError,
				});
			}
		});

		try {
			// Start retry chain
			await emitAssistantTurn(session, createRetryableErrorMessage({ timestamp: 1 }));

			// Emit non-retryable error that also contains a toolCall block
			const toolCallMessage: AssistantMessage = {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						name: "some_tool",
						arguments: { arg: "value" },
						id: "call_1",
					},
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "error",
				errorMessage: "Tool foo not found",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			await emitAssistantTurn(session, toolCallMessage);

			// Assert retry resolves within bounded time
			await Promise.race([
				new Promise<void>((resolve, reject) => {
					const check = setInterval(() => {
						if (!session.isRetrying) {
							clearInterval(check);
							resolve();
						}
					}, 10);
				}),
				Bun.sleep(500).then(() => {
					throw new Error("Timed out waiting for isRetrying to become false");
				}),
			]);

			const endEvent = events.find(e => e.type === "auto_retry_end" && e.success === false);
			expect(endEvent).toBeDefined();
		} finally {
			await session.dispose();
		}
	});
});

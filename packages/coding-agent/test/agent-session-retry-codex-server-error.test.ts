import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@spell/pi-agent-core";
import type { AssistantMessage } from "@spell/pi-ai";
import { getBundledModel } from "@spell/pi-ai/models";
import { TempDir } from "@spell/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

/**
 * BUG-493 regression: a raw Codex `error` event with `code=server_error` reached the
 * user without triggering the session-level auto-retry backstop, because
 * `#isRetryableErrorMessage` only matched phrase patterns ("server error") and missed
 * the `code=server_error` / `code=model_error` provider codes plus OS-level connection
 * failures (ECONNRESET/ETIMEDOUT/EAI_AGAIN). This asserts the exact reported error
 * string — and the wider gap class — now starts an auto-retry chain.
 */
function createErrorMessage(errorMessage: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-codex-responses",
		provider: "openai",
		model: "gpt-5-codex",
		stopReason: "error",
		errorMessage,
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

describe("AgentSession retry — BUG-493 Codex server_error / connection-failure gap", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-agent-session-retry-codex-server-error-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	function createSession(overrides: Record<string, unknown> = {}): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model");
		const agent = new Agent({
			initialState: { model, systemPrompt: "Test", tools: [], messages: [] },
		});
		return new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": true,
				"retry.maxRetries": 2,
				"retry.baseDelayMs": 1,
				"retry.maxDelayMs": 5,
				...overrides,
			}),
			modelRegistry,
		});
	}

	it("retries the exact reported Codex server_error incident", async () => {
		const session = createSession();
		let starts = 0;
		session.subscribe(event => {
			if (event.type === "auto_retry_start") starts += 1;
		});
		try {
			const message =
				"Codex error event: An error occurred while processing your request. You can retry your " +
				"request, or contact us through our help center at help.openai.com if the error persists. " +
				"Please include the request ID 4c5a67ac-7cc9-4e41-a6db-28e82c9f72cd in your message. " +
				"(code=server_error)";
			await emitAssistantTurn(session, createErrorMessage(message, { timestamp: 1 }));
			expect(starts).toBe(1);
		} finally {
			await session.dispose();
		}
	});

	it("retries provider-declared transient error codes (model_error, internal_error)", async () => {
		const session = createSession();
		let starts = 0;
		session.subscribe(event => {
			if (event.type === "auto_retry_start") starts += 1;
		});
		try {
			await emitAssistantTurn(
				session,
				createErrorMessage("Codex error event (code=model_error, message=The model produced an error)", {
					timestamp: 1,
				}),
			);
			expect(starts).toBe(1);
		} finally {
			await session.dispose();
		}
	});

	it("retries OS-level connection failures", async () => {
		const session = createSession();
		let starts = 0;
		session.subscribe(event => {
			if (event.type === "auto_retry_start") starts += 1;
		});
		try {
			await emitAssistantTurn(session, createErrorMessage("read ECONNRESET", { timestamp: 1 }));
			expect(starts).toBe(1);
		} finally {
			await session.dispose();
		}
	});

	it("still does not retry auth errors", async () => {
		const session = createSession();
		let starts = 0;
		session.subscribe(event => {
			if (event.type === "auto_retry_start") starts += 1;
		});
		try {
			await emitAssistantTurn(session, createErrorMessage("401 Unauthorized: invalid api key", { timestamp: 1 }));
			expect(starts).toBe(0);
		} finally {
			await session.dispose();
		}
	});
});

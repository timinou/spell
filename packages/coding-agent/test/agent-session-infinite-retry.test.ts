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
 * A plain retryable error message (no stream diagnostics). The `errorMessage` text drives
 * classification: an "overloaded"/"rate limit" body is retried infinitely, anything else
 * (e.g. "server error") stays bounded by retry.maxRetries.
 */
function createErrorMessage(errorMessage: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
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

interface StartEvent {
	attempt: number;
	maxAttempts: number | undefined;
	delayMs: number;
	infinite: boolean;
}

async function emitAssistantTurn(session: AgentSession, message: AssistantMessage): Promise<void> {
	session.agent.emitExternalEvent({ type: "message_end", message });
	session.agent.emitExternalEvent({ type: "agent_end", messages: [message] });
	await Promise.resolve();
	await Promise.resolve();
}

describe("AgentSession infinite retry on overloaded / rate limit", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-agent-session-infinite-retry-");
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
				"retry.infiniteOnRateLimit": true,
				...overrides,
			}),
			modelRegistry,
		});
	}

	function collectStarts(session: AgentSession): StartEvent[] {
		const starts: StartEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") {
				starts.push({
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					infinite: event.infinite,
				});
			}
		});
		return starts;
	}

	// NB: the synchronous test harness emits turns without waiting for each retry's backoff
	// sleep to resolve, so we assert only values that are stable regardless of overlap:
	//  - per-first-turn classification (attempt 1, before any abort race)
	//  - the give-up contract, reached via the immediate cap-exceed path (maxRetries=1, turn 2
	//    exceeds the bounded budget *before* sleeping, so no abort/reset race occurs).

	it("classifies the first overloaded error as an infinite retry", async () => {
		const session = createSession();
		const starts = collectStarts(session);
		try {
			const msg = createErrorMessage("server is Overloaded (529)", { timestamp: 1 });
			await emitAssistantTurn(session, msg);

			expect(starts).toHaveLength(1);
			expect(starts[0].infinite).toBe(true);
			expect(starts[0].maxAttempts).toBeUndefined();
			// Message shows no "/max" denominator in infinite mode.
			expect(msg.errorMessage).toBe("Attempt 1 failed; retrying. server is Overloaded (529)");
		} finally {
			await session.dispose();
		}
	});

	it("classifies rate-limit errors as infinite retries too", async () => {
		const session = createSession();
		const starts = collectStarts(session);
		try {
			await emitAssistantTurn(session, createErrorMessage("429 too many requests", { timestamp: 1 }));
			expect(starts[0].infinite).toBe(true);
			expect(starts[0].maxAttempts).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	it("keeps a plain server error bounded (not infinite)", async () => {
		const session = createSession();
		const starts = collectStarts(session);
		try {
			await emitAssistantTurn(session, createErrorMessage("server error 500", { timestamp: 1 }));
			expect(starts[0].infinite).toBe(false);
			expect(starts[0].maxAttempts).toBe(2);
		} finally {
			await session.dispose();
		}
	});

	it("clamps the first backoff to retry.maxDelayMs", async () => {
		// base 1000ms, ceiling 5ms → first (and every) wait is clamped to 5ms.
		const session = createSession({ "retry.baseDelayMs": 1000, "retry.maxDelayMs": 5 });
		const starts = collectStarts(session);
		try {
			await emitAssistantTurn(session, createErrorMessage("Overloaded (529)", { timestamp: 1 }));
			expect(starts[0].delayMs).toBe(5);
		} finally {
			await session.dispose();
		}
	});

	it("never takes the give-up path on overloaded errors past the cap", async () => {
		// maxRetries=1: a 2nd bounded error would give up. A 2nd overloaded error must NOT —
		// the bounded budget is never charged for infinite errors, so no "Final attempt".
		const session = createSession({ "retry.maxRetries": 1 });
		let finalError: string | undefined;
		session.subscribe(event => {
			if (event.type === "auto_retry_end" && !event.success) finalError = event.finalError;
		});
		try {
			await emitAssistantTurn(session, createErrorMessage("Overloaded (529)", { timestamp: 1 }));
			await emitAssistantTurn(session, createErrorMessage("Overloaded (529)", { timestamp: 2 }));
			await emitAssistantTurn(session, createErrorMessage("Overloaded (529)", { timestamp: 3 }));
			// May see a harness-induced "Retry cancelled" (overlapping sleeps aborting), but never a
			// real give-up ("Final attempt …").
			expect(finalError ?? "").not.toContain("Final attempt");
		} finally {
			await session.dispose();
		}
	});

	it("gives up on bounded errors at the cap via the immediate exceed path", async () => {
		// maxRetries=1: turn 1 sleeps, turn 2 exceeds the bounded cap *before* sleeping → give-up.
		const session = createSession({ "retry.maxRetries": 1 });
		let finalError: string | undefined;
		session.subscribe(event => {
			if (event.type === "auto_retry_end" && !event.success) finalError = event.finalError;
		});
		try {
			await emitAssistantTurn(session, createErrorMessage("server error 500", { timestamp: 1 }));
			await emitAssistantTurn(session, createErrorMessage("server error 500", { timestamp: 2 }));
			expect(finalError).toContain("Final attempt 1/1 failed.");
		} finally {
			await session.dispose();
		}
	});

	it("respects retry.infiniteOnRateLimit=false by giving up on overloaded at the cap", async () => {
		const session = createSession({ "retry.maxRetries": 1, "retry.infiniteOnRateLimit": false });
		const starts = collectStarts(session);
		let finalError: string | undefined;
		session.subscribe(event => {
			if (event.type === "auto_retry_end" && !event.success) finalError = event.finalError;
		});
		try {
			await emitAssistantTurn(session, createErrorMessage("Overloaded (529)", { timestamp: 1 }));
			await emitAssistantTurn(session, createErrorMessage("Overloaded (529)", { timestamp: 2 }));

			expect(starts[0].infinite).toBe(false);
			expect(starts[0].maxAttempts).toBe(1);
			expect(finalError).toContain("Final attempt 1/1 failed.");
		} finally {
			await session.dispose();
		}
	});
});

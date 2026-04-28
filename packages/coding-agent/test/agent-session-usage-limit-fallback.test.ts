import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../src/config/model-registry";
import { type SettingPath, Settings } from "../src/config/settings";
import { AgentSession, type AgentSessionEvent } from "../src/session/agent-session";
import type { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const KIMI_RATE_LIMIT_ERROR =
	'429 {"error":{"type":"rate_limit_error","message":"You\'ve reached your usage limit for this period. Your quota will be refreshed in the next period."},"type":"error"}';

const KIMI_BILLING_QUOTA_ERROR =
	'403 {"error":{"type":"permission_error","message":"You\'ve reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle."},"type":"error"}';

interface RetryEventSnapshot {
	type: "auto_retry_start" | "auto_retry_end";
	attempt: number;
	delayMs?: number;
	finalError?: string;
}

interface RegistryOptions {
	availableModels?: Model<Api>[];
	apiKeyProviders?: Set<string>;
	markUsageLimitReached?: () => Promise<boolean>;
}

function createModel(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		name: `${provider}/${id}`,
		api: "openai-responses",
		contextWindow: 128_000,
	} as Model<Api>;
}

function createUsageLimitMessage(
	errorMessage: string,
	model: Model<Api>,
	timestamp: number = Date.now(),
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
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
		timestamp,
	};
}

function createMockModelRegistry(options: RegistryOptions = {}): ModelRegistry {
	const apiKeyProviders = options.apiKeyProviders ?? new Set<string>();
	const markUsageLimitReached = options.markUsageLimitReached ?? vi.fn(async () => false);
	const authStorage = { markUsageLimitReached } as unknown as AuthStorage;

	return {
		authStorage,
		getAvailable: () => options.availableModels ?? [],
		getApiKey: async (model: Model<Api>) => (apiKeyProviders.has(model.provider) ? "test-key" : undefined),
	} as unknown as ModelRegistry;
}

function createSettings(overrides: Partial<Record<SettingPath, unknown>> = {}): Settings {
	return Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": true,
		"retry.maxRetries": 2,
		"retry.baseDelayMs": 1,
		...overrides,
	});
}

function createSession(options: {
	model: Model<Api>;
	modelRegistry: ModelRegistry;
	taskDepth?: number;
	settings?: Settings;
}): AgentSession {
	const agent = new Agent({
		initialState: {
			model: options.model,
			systemPrompt: "Test",
			tools: [],
			messages: [],
		},
	});

	return new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: options.settings ?? createSettings(),
		modelRegistry: options.modelRegistry,
		taskDepth: options.taskDepth,
	});
}

async function emitAssistantTurn(session: AgentSession, message: AssistantMessage): Promise<void> {
	session.agent.emitExternalEvent({ type: "message_end", message });
	session.agent.emitExternalEvent({ type: "agent_end", messages: [message] });
	await Promise.resolve();
	await Promise.resolve();
	await Bun.sleep(20);
}

function collectRetryEvents(session: AgentSession): RetryEventSnapshot[] {
	const events: RetryEventSnapshot[] = [];
	session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "auto_retry_start") {
			events.push({ type: event.type, attempt: event.attempt, delayMs: event.delayMs });
		} else if (event.type === "auto_retry_end") {
			events.push({ type: event.type, attempt: event.attempt, finalError: event.finalError });
		}
	});
	return events;
}

describe("AgentSession subagent usage-limit retry policy", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("caps subagent transient rate-limit sleep to retry.subagentUsageLimitMaxDelayMs", async () => {
		const kimi = createModel("moonshot", "kimi-k2");
		const session = createSession({
			model: kimi,
			modelRegistry: createMockModelRegistry({ availableModels: [kimi], apiKeyProviders: new Set(["moonshot"]) }),
			taskDepth: 1,
			settings: createSettings({
				"retry.subagentUsageLimitMaxDelayMs": 7,
				"retry.subagentUsageLimitFallbackRoles": [],
			}),
		});
		const events = collectRetryEvents(session);

		try {
			await emitAssistantTurn(session, createUsageLimitMessage(KIMI_RATE_LIMIT_ERROR, kimi, 1));

			expect(events).toContainEqual({ type: "auto_retry_start", attempt: 1, delayMs: 7 });
			expect(events.some(event => event.delayMs === 30 * 60 * 1000)).toBe(false);
		} finally {
			session.abortRetry();
			await session.dispose();
		}
	});

	it("fails fast for subagent quota exhaustion when no credential or model fallback exists", async () => {
		const kimi = createModel("moonshot", "kimi-k2");
		const session = createSession({
			model: kimi,
			modelRegistry: createMockModelRegistry({ availableModels: [kimi], apiKeyProviders: new Set(["moonshot"]) }),
			taskDepth: 1,
			settings: createSettings({
				"retry.subagentUsageLimitMaxDelayMs": 7,
				"retry.subagentUsageLimitFallbackRoles": [],
			}),
		});
		const events = collectRetryEvents(session);

		try {
			await emitAssistantTurn(session, createUsageLimitMessage(KIMI_BILLING_QUOTA_ERROR, kimi, 1));

			expect(events).toEqual([
				{
					type: "auto_retry_end",
					attempt: 1,
					finalError: expect.stringContaining("usage limit exhausted"),
				},
			]);
			expect(session.retryAttempt).toBe(0);
		} finally {
			await session.dispose();
		}
	});

	it("switches a subagent to the first configured fallback role with an API key", async () => {
		const kimi = createModel("moonshot", "kimi-k2");
		const noKeyFallback = createModel("anthropic", "claude-opus-4-6");
		const usableFallback = createModel("openai", "gpt-4o");
		const session = createSession({
			model: kimi,
			modelRegistry: createMockModelRegistry({
				availableModels: [kimi, noKeyFallback, usableFallback],
				apiKeyProviders: new Set(["moonshot", "openai"]),
			}),
			taskDepth: 1,
			settings: createSettings({
				modelRoles: { task: "moonshot/kimi-k2", slow: "anthropic/claude-opus-4-6", smol: "openai/gpt-4o" },
				"retry.subagentUsageLimitFallbackRoles": ["task", "slow", "smol"],
			}),
		});
		const events = collectRetryEvents(session);

		try {
			await emitAssistantTurn(session, createUsageLimitMessage(KIMI_BILLING_QUOTA_ERROR, kimi, 1));

			expect(session.model).toBe(usableFallback);
			expect(events).toContainEqual({ type: "auto_retry_start", attempt: 1, delayMs: 0 });
		} finally {
			session.abortRetry();
			await session.dispose();
		}
	});

	it("preserves top-level quota compatibility by allowing the existing long quota delay", async () => {
		const kimi = createModel("moonshot", "kimi-k2");
		const session = createSession({
			model: kimi,
			modelRegistry: createMockModelRegistry({ availableModels: [kimi], apiKeyProviders: new Set(["moonshot"]) }),
			taskDepth: 0,
			settings: createSettings({ "retry.subagentUsageLimitMaxDelayMs": 7 }),
		});
		const events = collectRetryEvents(session);

		try {
			await emitAssistantTurn(session, createUsageLimitMessage(KIMI_BILLING_QUOTA_ERROR, kimi, 1));

			expect(events).toContainEqual({ type: "auto_retry_start", attempt: 1, delayMs: 30 * 60 * 1000 });
		} finally {
			session.abortRetry();
			await session.dispose();
		}
	});
});

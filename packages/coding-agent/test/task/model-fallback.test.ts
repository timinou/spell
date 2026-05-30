import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, AssistantMessage, Model } from "@spell/pi-ai";
import { Settings } from "../../src/config/settings";
import type { LoadExtensionsResult } from "../../src/extensibility/extensions/types";
import * as sdkModule from "../../src/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "../../src/session/agent-session";
import type { AuthStorage } from "../../src/session/auth-storage";
import { runSubprocess, SUBAGENT_WARNING_MISSING_SUBMIT_RESULT } from "../../src/task/executor";
import type { AgentDefinition } from "../../src/task/types";

vi.mock("../../src/sdk", () => ({
	createAgentSession: vi.fn(),
	discoverAuthStorage: vi.fn(async () => ({})),
}));

function createAssistantStopMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "openai-responses",
		provider: "openai",
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

function createAssistantErrorMessage(errorMessage: string, text: string = errorMessage): AssistantMessage {
	return {
		...createAssistantStopMessage(text),
		stopReason: "error",
		errorMessage,
	};
}

function createMockSession(
	onPrompt: (params: {
		text: string;
		options?: PromptOptions;
		promptIndex: number;
		emit: (event: AgentSessionEvent) => void;
		state: { messages: AssistantMessage[] };
	}) => void,
	model?: Model<Api>,
	sessionId: string = "mock-model-fallback-session",
): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as AssistantMessage[] };
	let promptIndex = 0;

	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};

	const session = {
		sessionId,
		state,
		agent: { state: { systemPrompt: "test" } },
		model,
		extensionRunner: undefined,
		sessionManager: {
			appendSessionInit: () => {},
		},
		getActiveToolNames: () => ["read", "submit_result"],
		setActiveToolsByName: async (_toolNames: string[]) => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (text: string, options?: PromptOptions) => {
			promptIndex += 1;
			onPrompt({ text, options, promptIndex, emit, state });
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => state.messages[state.messages.length - 1],
		abort: async () => {},
		dispose: async () => {},
	};

	return session as unknown as AgentSession;
}

describe("runSubprocess delegated model fallback", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const baseAgent: AgentDefinition = {
		name: "task",
		description: "test",
		systemPrompt: "test",
		source: "bundled",
	};

	const anthropicModel = {
		provider: "anthropic",
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6",
		api: "anthropic-messages",
	} as unknown as Model<Api>;
	const openaiModel = {
		provider: "openai",
		id: "gpt-4o",
		name: "GPT-4o",
		api: "openai-responses",
	} as unknown as Model<Api>;

	const baseOptions = {
		cwd: "/tmp",
		agent: baseAgent,
		task: "do work",
		index: 0,
		id: "subagent-fallback-1",
		settings: Settings.isolated(),
		authStorage: { markAuthFailure: vi.fn(async () => false) } as unknown as AuthStorage,
		modelRegistry: {
			refresh: async () => {},
			getAvailable: () => [anthropicModel, openaiModel],
		} as unknown as import("../../src/config/model-registry").ModelRegistry,
		enableLsp: false,
		outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
	};

	it("falls back to the next allowed candidate after startup auth failure", async () => {
		const authStorage = { markAuthFailure: vi.fn(async () => false) } as unknown as AuthStorage;
		const failingSession = createMockSession(
			({ promptIndex, emit, state }) => {
				if (promptIndex !== 1) return;
				const assistant = createAssistantErrorMessage("401 Invalid bearer token", "anthropic startup failed");
				state.messages.push(assistant);
				emit({ type: "message_end", message: assistant });
			},
			anthropicModel,
			"session-anthropic",
		);
		const fallbackSession = createMockSession(
			({ emit }) => {
				emit({
					type: "tool_execution_end",
					toolCallId: "tool-submit-result-fallback",
					toolName: "submit_result",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { ok: true } },
					},
					isError: false,
				});
			},
			openaiModel,
			"session-openai",
		);

		(
			sdkModule.createAgentSession as unknown as {
				mockResolvedValueOnce: (value: unknown) => unknown;
			}
		).mockResolvedValueOnce({
			session: failingSession,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
		});
		(
			sdkModule.createAgentSession as unknown as {
				mockResolvedValueOnce: (value: unknown) => unknown;
			}
		).mockResolvedValueOnce({
			session: fallbackSession,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
		});

		const result = await runSubprocess({
			...baseOptions,
			authStorage,
			modelOverride: ["anthropic/claude-opus-4-6", "openai/gpt-4o"],
		});

		expect(result.exitCode).toBe(0);
		expect(result.structuredResult).toMatchObject({ ok: true });
		expect(result.error).toBeUndefined();
		expect(result.sessionId).toBe("session-openai");
		expect((authStorage.markAuthFailure as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(1);
		const createAgentSessionMock = sdkModule.createAgentSession as unknown as {
			mock: { calls: Array<[Record<string, unknown>]> };
		};
		expect(createAgentSessionMock.mock.calls).toHaveLength(2);
		expect(createAgentSessionMock.mock.calls[0]?.[0]?.model).toBe(anthropicModel);
		expect(createAgentSessionMock.mock.calls[1]?.[0]?.model).toBe(openaiModel);
	});

	it("keeps the root auth error when no alternate candidate exists", async () => {
		const authStorage = { markAuthFailure: vi.fn(async () => false) } as unknown as AuthStorage;
		const failingSession = createMockSession(
			({ promptIndex, emit, state }) => {
				if (promptIndex !== 1) return;
				const assistant = createAssistantErrorMessage("401 Invalid bearer token", "anthropic startup failed");
				state.messages.push(assistant);
				emit({ type: "message_end", message: assistant });
			},
			anthropicModel,
			"session-anthropic-only",
		);

		(
			sdkModule.createAgentSession as unknown as { mockResolvedValueOnce: (value: unknown) => unknown }
		).mockResolvedValueOnce({
			session: failingSession,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
		});

		const result = await runSubprocess({
			...baseOptions,
			authStorage,
			modelOverride: ["anthropic/claude-opus-4-6"],
		});

		expect(result.exitCode).toBe(1);
		expect(result.error).toBe("401 Invalid bearer token");
		expect(result.stderr).toBe("401 Invalid bearer token");
		expect(result.textPreview?.includes(SUBAGENT_WARNING_MISSING_SUBMIT_RESULT) ?? false).toBe(false);
		expect((authStorage.markAuthFailure as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(1);
	});
});

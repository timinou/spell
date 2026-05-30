import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, AssistantMessage, Model } from "@spell/pi-ai";
import { logger } from "@spell/pi-utils";
import { Settings } from "../../src/config/settings";
import type { LoadExtensionsResult } from "../../src/extensibility/extensions/types";

import type { AgentSession, AgentSessionEvent, PromptOptions } from "../../src/session/agent-session";
import type { AuthStorage } from "../../src/session/auth-storage";

import type { AgentDefinition } from "../../src/task/types";

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

function createMockSession(
	onPrompt: (params: {
		text: string;
		options?: PromptOptions;
		promptIndex: number;
		emit: (event: AgentSessionEvent) => void;
		state: { messages: AssistantMessage[] };
	}) => void,
	abort: () => Promise<void>,
	model?: Model<Api>,
): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as AssistantMessage[] };
	let promptIndex = 0;

	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};

	const session = {
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
		abort,
		dispose: async () => {},
	};

	return session as unknown as AgentSession;
}

function emitReadToolExecutions(emit: (event: AgentSessionEvent) => void, count: number): void {
	for (let index = 1; index <= count; index++) {
		const toolCallId = `tool-read-${index}`;
		emit({
			type: "tool_execution_start",
			toolCallId,
			toolName: "read",
			args: { path: `/tmp/${toolCallId}.txt` },
		});
		emit({
			type: "tool_execution_end",
			toolCallId,
			toolName: "read",
			result: { content: [{ type: "text", text: "read complete" }] },
			isError: false,
		});
	}
}

function emitSubmitResult(
	emit: (event: AgentSessionEvent) => void,
	data: Record<string, boolean | number | string>,
): void {
	emit({
		type: "tool_execution_end",
		toolCallId: "tool-submit-result",
		toolName: "submit_result",
		result: {
			content: [{ type: "text", text: "Result submitted." }],
			details: { status: "success", data },
		},
		isError: false,
	});
}

async function mockCreateAgentSession(session: AgentSession): Promise<void> {
	const sdkModule = await import("../../src/sdk");
	vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
		session,
		extensionsResult: {} as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
	} as never);
	vi.spyOn(sdkModule, "discoverAuthStorage").mockResolvedValue({} as never);
}

function getBudgetWarningCount(warnSpy: { mock: { calls: unknown[][] } }): number {
	return warnSpy.mock.calls.filter(call => call[0] === "Subagent exceeded tool call budget").length;
}

describe("runSubprocess tool call budget", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const baseAgent: AgentDefinition = {
		name: "task",
		description: "test",
		systemPrompt: "test",
		source: "bundled",
	};

	const baseOptions = {
		cwd: "/tmp",
		agent: baseAgent,
		task: "do work",
		index: 0,
		id: "subagent-tool-budget",
		authStorage: {} as unknown as AuthStorage,
		modelRegistry: { refresh: async () => {} } as unknown as import("../../src/config/model-registry").ModelRegistry,
		enableLsp: false,
	};

	it("aborts when tool count exceeds budget and still accepts submit_result reminder recovery", async () => {
		const prompts: string[] = [];
		const abortSpy = vi.fn(async () => {});
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const session = createMockSession(({ text, promptIndex, emit, state }) => {
			prompts.push(text);
			if (promptIndex === 1) {
				emitReadToolExecutions(emit, 4);
				const assistant = createAssistantStopMessage("did work but missed submit_result");
				state.messages.push(assistant);
				emit({ type: "message_end", message: assistant });
				return;
			}
			emitSubmitResult(emit, { recovered: true });
		}, abortSpy);
		await mockCreateAgentSession(session);

		const { runSubprocess } = await import("../../src/task/executor");
		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-budget-exceeded",
			settings: Settings.isolated({ "task.maxToolCalls": 3 }),
		});

		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain("You stopped without calling submit_result");
		expect(abortSpy).toHaveBeenCalled();
		expect(getBudgetWarningCount(warnSpy)).toBe(1);
		expect(result.structuredResult).toEqual({ recovered: true });
	});

	it("does not abort when subagent completes within budget", async () => {
		const abortSpy = vi.fn(async () => {});
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const session = createMockSession(({ emit }) => {
			emitReadToolExecutions(emit, 5);
			emitSubmitResult(emit, { withinBudget: true });
		}, abortSpy);
		await mockCreateAgentSession(session);

		const { runSubprocess } = await import("../../src/task/executor");
		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-budget-within-limit",
			settings: Settings.isolated({ "task.maxToolCalls": 10 }),
		});

		expect(getBudgetWarningCount(warnSpy)).toBe(0);
		expect(result.structuredResult).toEqual({ withinBudget: true });
	});

	it("disables enforcement when task.maxToolCalls is set to 0", async () => {
		const abortSpy = vi.fn(async () => {});
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const session = createMockSession(({ emit }) => {
			emitReadToolExecutions(emit, 300);
			emitSubmitResult(emit, { enforcementDisabled: true });
		}, abortSpy);
		await mockCreateAgentSession(session);

		const { runSubprocess } = await import("../../src/task/executor");
		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-budget-disabled",
			settings: Settings.isolated({ "task.maxToolCalls": 0 }),
		});

		expect(getBudgetWarningCount(warnSpy)).toBe(0);
		expect(result.structuredResult).toEqual({ enforcementDisabled: true });
	});

	it("does not abort when tool count is exactly at maxToolCalls", async () => {
		const abortSpy = vi.fn(async () => {});
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const session = createMockSession(({ emit }) => {
			emitReadToolExecutions(emit, 5);
			emitSubmitResult(emit, { exactLimit: true });
		}, abortSpy);
		await mockCreateAgentSession(session);

		const { runSubprocess } = await import("../../src/task/executor");
		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-budget-at-limit",
			settings: Settings.isolated({ "task.maxToolCalls": 5 }),
		});

		expect(getBudgetWarningCount(warnSpy)).toBe(0);
		expect(result.structuredResult).toEqual({ exactLimit: true });
	});
	it("uses default maxToolCalls=200 when not explicitly configured", async () => {
		const prompts: string[] = [];
		const abortSpy = vi.fn(async () => {});
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const session = createMockSession(({ text, promptIndex, emit, state }) => {
			prompts.push(text);
			if (promptIndex === 1) {
				emitReadToolExecutions(emit, 201);
				const assistant = createAssistantStopMessage("hit implicit default budget");
				state.messages.push(assistant);
				emit({ type: "message_end", message: assistant });
				return;
			}
			emitSubmitResult(emit, { defaultBudgetApplied: true });
		}, abortSpy);
		await mockCreateAgentSession(session);

		const { runSubprocess } = await import("../../src/task/executor");
		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-budget-default",
			settings: Settings.isolated(),
		});

		expect(prompts).toHaveLength(2);
		expect(getBudgetWarningCount(warnSpy)).toBe(1);
		expect(result.structuredResult).toEqual({ defaultBudgetApplied: true });
	});
});

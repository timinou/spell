import { afterEach, describe, expect, it, vi } from "bun:test";
import { type Api, type AssistantMessage, Effort, type Model } from "@oh-my-pi/pi-ai";
import { Settings } from "../../src/config/settings";
import type { LoadExtensionsResult } from "../../src/extensibility/extensions/types";
import * as sdkModule from "../../src/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "../../src/session/agent-session";
import type { AuthStorage } from "../../src/session/auth-storage";
import {
	runSubprocess,
	SUBAGENT_WARNING_MISSING_SUBMIT_RESULT,
	SUBAGENT_WARNING_MISSING_VERIFICATION_PROOF,
} from "../../src/task/executor";
import type { AgentDefinition, AgentProgress } from "../../src/task/types";

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
	activeToolNames: string[] = ["read", "submit_result"],
): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as AssistantMessage[] };
	let promptIndex = 0;

	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};

	const session = {
		sessionId: "mock-subagent-session",
		state,
		agent: { state: { systemPrompt: "test" } },
		model,
		extensionRunner: undefined,
		sessionManager: {
			appendSessionInit: () => {},
		},
		getActiveToolNames: () => activeToolNames,
		setActiveToolsByName: async (_toolNames: string[]) => {},
		refreshBaseSystemPrompt: async () => {},
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

function renderPromptText(prompt: unknown): string {
	if (typeof prompt === "string") return prompt;
	if (!Array.isArray(prompt)) return "";
	return prompt
		.map(block => {
			if (typeof block === "string") return block;
			if (!block || typeof block !== "object") return "";
			return "text" in block && typeof block.text === "string" ? block.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

describe("runSubprocess submit_result reminders", () => {
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
		id: "subagent-1",
		settings: Settings.isolated({ "todo.enabled": true }),
		authStorage: {} as unknown as AuthStorage,
		modelRegistry: { refresh: async () => {} } as unknown as import("../../src/config/model-registry").ModelRegistry,
		enableLsp: false,
	};

	it("requests submit_result injection for subagent sessions", async () => {
		const session = createMockSession(({ emit }) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-submit-result",
				toolName: "submit_result",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});

		(sdkModule.createAgentSession as unknown as { mockResolvedValue: (value: unknown) => void }).mockResolvedValue({
			session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
		});

		await runSubprocess({
			...baseOptions,
			id: "subagent-submit-result-injected",
			agent: { ...baseAgent, tools: ["read"] },
		});

		const createAgentSessionMock = sdkModule.createAgentSession as unknown as {
			mock: { calls: Array<[Record<string, unknown>]> };
		};
		expect(createAgentSessionMock.mock.calls).toHaveLength(1);
		expect(createAgentSessionMock.mock.calls[0]?.[0]?.toolNames).toEqual(["read"]);
		expect(createAgentSessionMock.mock.calls[0]?.[0]?.requireSubmitResultTool).toBe(true);
	});

	it("suppresses todo_write-only overlay instructions when the delegated toolset cannot call todo_write", async () => {
		const session = createMockSession(({ emit }) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-submit-result",
				toolName: "submit_result",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});

		(sdkModule.createAgentSession as unknown as { mockResolvedValue: (value: unknown) => void }).mockResolvedValue({
			session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
		});

		await runSubprocess({
			...baseOptions,
			id: "subagent-overlay-without-todo",
			agent: { ...baseAgent, tools: ["read"] },
		});

		const createAgentSessionMock = sdkModule.createAgentSession as unknown as {
			mock: { calls: Array<[Record<string, unknown>]> };
		};
		const promptFactory = createAgentSessionMock.mock.calls.at(-1)?.[0]?.systemPrompt as
			| ((defaultBlocks: unknown[]) => unknown)
			| undefined;
		const overlay = renderPromptText(promptFactory?.([]));
		expect(overlay).not.toContain("You **MUST** use `todo_write` to plan tasks with 3+ steps.");
		expect(overlay).toContain("`todo_write` is not available in this delegated session.");
	});

	it("keeps todo_write overlay guidance when the delegated toolset includes todo_write", async () => {
		const session = createMockSession(
			({ emit }) => {
				emit({
					type: "tool_execution_end",
					toolCallId: "tool-submit-result",
					toolName: "submit_result",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { ok: true } },
					},
					isError: false,
				});
			},
			undefined,
			["read", "todo_write", "submit_result"],
		);

		(sdkModule.createAgentSession as unknown as { mockResolvedValue: (value: unknown) => void }).mockResolvedValue({
			session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
		});

		await runSubprocess({
			...baseOptions,
			id: "subagent-overlay-with-todo",
			agent: { ...baseAgent, tools: ["read", "todo_write"] },
		});

		const createAgentSessionMock = sdkModule.createAgentSession as unknown as {
			mock: { calls: Array<[Record<string, unknown>]> };
		};
		const promptFactory = createAgentSessionMock.mock.calls.at(-1)?.[0]?.systemPrompt as
			| ((defaultBlocks: unknown[]) => unknown)
			| undefined;
		const overlay = renderPromptText(promptFactory?.([]));
		expect(overlay).toContain("You **MUST** use `todo_write` to plan tasks with 3+ steps.");
		expect(overlay).not.toContain("`todo_write` is not available in this delegated session.");
	});

	it("includes todo_write overlay when the agent has unrestricted tools", async () => {
		const session = createMockSession(
			({ emit }) => {
				emit({
					type: "tool_execution_end",
					toolCallId: "tool-submit-result",
					toolName: "submit_result",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { ok: true } },
					},
					isError: false,
				});
			},
			undefined,
			["read", "todo_write", "submit_result"],
		);

		(sdkModule.createAgentSession as unknown as { mockResolvedValue: (value: unknown) => void }).mockResolvedValue({
			session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
		});

		await runSubprocess({
			...baseOptions,
			id: "subagent-overlay-unrestricted-tools",
		});

		const createAgentSessionMock = sdkModule.createAgentSession as unknown as {
			mock: { calls: Array<[Record<string, unknown>]> };
		};
		const promptFactory = createAgentSessionMock.mock.calls.at(-1)?.[0]?.systemPrompt as
			| ((defaultBlocks: unknown[]) => unknown)
			| undefined;
		const overlay = renderPromptText(promptFactory?.([]));
		expect(createAgentSessionMock.mock.calls.at(-1)?.[0]?.toolNames).toBeUndefined();
		expect(overlay).toContain("You **MUST** use `todo_write` to plan tasks with 3+ steps.");
		expect(overlay).not.toContain("`todo_write` is not available in this delegated session.");
	});

	it("sends reminder prompt when subagent stops without submit_result", async () => {
		const prompts: string[] = [];
		const promptOptions: Array<PromptOptions | undefined> = [];
		const session = createMockSession(({ text, options, promptIndex, emit, state }) => {
			prompts.push(text);
			promptOptions.push(options);
			if (promptIndex === 1) {
				const assistant = createAssistantStopMessage("did some work");
				state.messages.push(assistant);
				emit({ type: "message_end", message: assistant });
				return;
			}
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "submit_result",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { done: true } },
				},
				isError: false,
			});
		});

		(sdkModule.createAgentSession as unknown as { mockResolvedValue: (value: unknown) => void }).mockResolvedValue({
			session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
		});

		const result = await runSubprocess(baseOptions);
		expect(prompts.length).toBe(2);
		expect(promptOptions).toHaveLength(2);
		expect(promptOptions[0]?.attribution).toBe("agent");
		expect(promptOptions[1]?.attribution).toBe("agent");
		expect(prompts[1]).toContain("You stopped without calling submit_result");
		expect(result.output).toContain('"done": true');
		expect(result.output.includes("SYSTEM WARNING")).toBe(false);
	});

	it("accepts gated submit_result success when proof is already observed", async () => {
		const prompts: string[] = [];
		const promptOptions: Array<PromptOptions | undefined> = [];
		const session = createMockSession(({ text, options, emit }) => {
			prompts.push(text);
			promptOptions.push(options);
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-bash",
				toolName: "bash",
				args: { command: "bun test packages/coding-agent/test/task/executor-subagent-reminders.test.ts" },
				result: {
					content: [{ type: "text", text: "ok" }],
					details: { exitCode: 0, cwd: "/tmp" },
				},
				isError: false,
			} as AgentSessionEvent);
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-submit-result-proof",
				toolName: "submit_result",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});

		(sdkModule.createAgentSession as unknown as { mockResolvedValue: (value: unknown) => void }).mockResolvedValue({
			session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
		});

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-gated-proof-first",
			runtimeVerification: {
				gateCmd: "bun test packages/coding-agent/test/task/executor-subagent-reminders.test.ts",
			},
		});
		expect(prompts).toHaveLength(1);
		expect(promptOptions[0]?.toolChoice).toBeUndefined();
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('"ok": true');
	});

	it("retries exactly once when gated success arrives before proof and then accepts verified success", async () => {
		const prompts: string[] = [];
		const promptOptions: Array<PromptOptions | undefined> = [];
		const session = createMockSession(({ text, options, promptIndex, emit, state }) => {
			prompts.push(text);
			promptOptions.push(options);
			if (promptIndex === 1) {
				const assistant = createAssistantStopMessage("submitted too early");
				state.messages.push(assistant);
				emit({ type: "message_end", message: assistant });
				emit({
					type: "tool_execution_end",
					toolCallId: "tool-submit-result-too-early",
					toolName: "submit_result",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { ok: true } },
					},
					isError: false,
				});
				return;
			}
			expect(text).toContain("required verification proof");
			expect(options?.toolChoice).toBeUndefined();
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-bash-after-retry",
				toolName: "bash",
				args: { command: "bun test packages/coding-agent/test/task/executor-subagent-reminders.test.ts" },
				result: {
					content: [{ type: "text", text: "ok" }],
					details: { exitCode: 0, cwd: "/tmp" },
				},
				isError: false,
			} as AgentSessionEvent);
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-submit-result-after-proof",
				toolName: "submit_result",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true, retried: true } },
				},
				isError: false,
			});
		});

		(sdkModule.createAgentSession as unknown as { mockResolvedValue: (value: unknown) => void }).mockResolvedValue({
			session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
		});

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-gated-retry-once",
			runtimeVerification: {
				gateCmd: "bun test packages/coding-agent/test/task/executor-subagent-reminders.test.ts",
			},
		});
		expect(prompts).toHaveLength(2);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('"retried": true');
	});

	it("fails honestly when proof is still missing after the single runtime retry", async () => {
		const prompts: string[] = [];
		const session = createMockSession(({ text, promptIndex, emit, state }) => {
			prompts.push(text);
			const assistant = createAssistantStopMessage(`attempt ${promptIndex}`);
			state.messages.push(assistant);
			emit({ type: "message_end", message: assistant });
			emit({
				type: "tool_execution_end",
				toolCallId: `tool-submit-result-${promptIndex}`,
				toolName: "submit_result",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { attempt: promptIndex } },
				},
				isError: false,
			});
			if (promptIndex > 1) {
				expect(text).toContain("required verification proof");
			}
		});

		(sdkModule.createAgentSession as unknown as { mockResolvedValue: (value: unknown) => void }).mockResolvedValue({
			session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
		});

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-gated-proof-still-missing",
			runtimeVerification: {
				gateCmd: "bun test packages/coding-agent/test/task/executor-subagent-reminders.test.ts",
			},
		});
		expect(prompts).toHaveLength(2);
		expect(result.exitCode).toBe(1);
		expect(result.error).toContain(SUBAGENT_WARNING_MISSING_VERIFICATION_PROOF);
		expect(result.output).not.toContain('"attempt": 2');
	});

	it("keeps null submit_result warning when subagent submits success without data", async () => {
		const session = createMockSession(({ promptIndex, emit, state }) => {
			if (promptIndex === 1) {
				const assistant = createAssistantStopMessage("partial output");
				state.messages.push(assistant);
				emit({ type: "message_end", message: assistant });
				return;
			}
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-2",
				toolName: "submit_result",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success" },
				},
				isError: false,
			});
		});

		(sdkModule.createAgentSession as unknown as { mockResolvedValue: (value: unknown) => void }).mockResolvedValue({
			session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
		});

		const result = await runSubprocess({ ...baseOptions, id: "subagent-2" });
		expect(result.output).toContain("SYSTEM WARNING: Subagent called submit_result with null data.");
	});

	it("retries when submit_result tool returns an error before succeeding", async () => {
		const prompts: string[] = [];
		const session = createMockSession(({ text, promptIndex, emit, state }) => {
			prompts.push(text);
			if (promptIndex === 1) {
				const assistant = createAssistantStopMessage("attempted submit_result");
				state.messages.push(assistant);
				emit({ type: "message_end", message: assistant });
				emit({
					type: "tool_execution_end",
					toolCallId: "tool-error",
					toolName: "submit_result",
					result: {
						content: [{ type: "text", text: "Output does not match schema" }],
						details: { status: "error", error: "Output does not match schema" },
					},
					isError: true,
				});
				return;
			}
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-success",
				toolName: "submit_result",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});

		(sdkModule.createAgentSession as unknown as { mockResolvedValue: (value: unknown) => void }).mockResolvedValue({
			session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
		});

		const result = await runSubprocess({ ...baseOptions, id: "subagent-err-then-success" });
		expect(prompts).toHaveLength(2);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('"ok": true');
	});
	it("drops forced tool choice on the final reminder attempt", async () => {
		const promptOptions: Array<PromptOptions | undefined> = [];
		const session = createMockSession(
			({ options, promptIndex, emit, state }) => {
				promptOptions.push(options);
				if (promptIndex < 4) {
					const assistant = createAssistantStopMessage(`attempt ${promptIndex}`);
					state.messages.push(assistant);
					emit({ type: "message_end", message: assistant });
					return;
				}
				emit({
					type: "tool_execution_end",
					toolCallId: "tool-final-retry",
					toolName: "submit_result",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { ok: true } },
					},
					isError: false,
				});
			},
			{ api: "openai-responses" } as Model<Api>,
		);

		(sdkModule.createAgentSession as unknown as { mockResolvedValue: (value: unknown) => void }).mockResolvedValue({
			session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
		});

		const result = await runSubprocess({ ...baseOptions, id: "subagent-final-retry" });
		expect(promptOptions).toHaveLength(4);
		expect(promptOptions[1]?.toolChoice).toEqual({ type: "function", name: "submit_result" });
		expect(promptOptions[2]?.toolChoice).toEqual({ type: "function", name: "submit_result" });
		expect(promptOptions[3]?.toolChoice).toBeUndefined();
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('"ok": true');
	});

	it("uses provided thinking level when model override has no explicit suffix", async () => {
		vi.clearAllMocks();
		const session = createMockSession(({ emit }) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-thinking-fallback",
				toolName: "submit_result",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});

		(sdkModule.createAgentSession as unknown as { mockResolvedValue: (value: unknown) => void }).mockResolvedValue({
			session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
		});

		const modelRegistry = {
			refresh: async () => {},
			getAvailable: () => [{ provider: "openai", id: "gpt-4o", name: "GPT-4o" }],
		} as unknown as import("../../src/config/model-registry").ModelRegistry;

		await runSubprocess({
			...baseOptions,
			id: "subagent-thinking-fallback",
			modelOverride: "openai/gpt-4o",
			thinkingLevel: Effort.High,
			modelRegistry,
		});

		const createAgentSessionMock = sdkModule.createAgentSession as unknown as {
			mock: { calls: Array<[Record<string, unknown>]> };
		};
		expect(createAgentSessionMock.mock.calls).toHaveLength(1);
		expect(createAgentSessionMock.mock.calls[0]?.[0]?.thinkingLevel).toBe("high");
	});

	it("prefers explicit modelOverride thinking suffix over provided thinking level, including off", async () => {
		vi.clearAllMocks();
		const modelRegistry = {
			refresh: async () => {},
			getAvailable: () => [{ provider: "openai", id: "gpt-4o", name: "GPT-4o" }],
		} as unknown as import("../../src/config/model-registry").ModelRegistry;

		const cases = [
			{ modelOverride: "openai/gpt-4o:low", expectedThinkingLevel: Effort.Low },
			{ modelOverride: "openai/gpt-4o:off", expectedThinkingLevel: "off" },
		] as const;

		for (const [index, testCase] of cases.entries()) {
			const session = createMockSession(({ emit }) => {
				emit({
					type: "tool_execution_end",
					toolCallId: `tool-thinking-override-${index}`,
					toolName: "submit_result",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { ok: true } },
					},
					isError: false,
				});
			});

			(sdkModule.createAgentSession as unknown as { mockResolvedValue: (value: unknown) => void }).mockResolvedValue(
				{
					session,
					extensionsResult: {} as unknown as LoadExtensionsResult,
					setToolUIContext: () => {},
				},
			);

			await runSubprocess({
				...baseOptions,
				id: `subagent-thinking-override-${index}`,
				modelOverride: testCase.modelOverride,
				thinkingLevel: Effort.High,
				modelRegistry,
			});
		}

		const createAgentSessionMock = sdkModule.createAgentSession as unknown as {
			mock: { calls: Array<[Record<string, unknown>]> };
		};
		expect(createAgentSessionMock.mock.calls).toHaveLength(2);
		expect(createAgentSessionMock.mock.calls[0]?.[0]?.thinkingLevel).toBe(cases[0].expectedThinkingLevel);
		expect(createAgentSessionMock.mock.calls[1]?.[0]?.thinkingLevel).toBe(cases[1].expectedThinkingLevel);
	});
	it("completes with a warning after 3 reminders when submit_result is never called but work happened", async () => {
		const prompts: string[] = [];
		const session = createMockSession(({ text, promptIndex, emit, state }) => {
			prompts.push(text);
			if (promptIndex === 1) {
				emit({
					type: "tool_execution_start",
					toolCallId: "tool-read-1",
					toolName: "read",
					args: { path: "/tmp/work-note.txt" },
				});
				emit({
					type: "tool_execution_end",
					toolCallId: "tool-read-1",
					toolName: "read",
					result: { content: [{ type: "text", text: "read complete" }] },
					isError: false,
				});
			}
			const assistant = createAssistantStopMessage(promptIndex === 1 ? "did work" : "still no submit_result");
			state.messages.push(assistant);
			emit({ type: "message_end", message: assistant });
		});

		(sdkModule.createAgentSession as unknown as { mockResolvedValue: (value: unknown) => void }).mockResolvedValue({
			session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
		});

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-3",
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		});
		expect(prompts).toHaveLength(4);
		expect(result.exitCode).toBe(0);
		expect(result.aborted).toBe(false);
		expect(result.stderr).toBe("");
		expect(result.error).toBeUndefined();
		expect(result.abortReason).toBeUndefined();
		expect(result.output).toContain(SUBAGENT_WARNING_MISSING_SUBMIT_RESULT);
		expect(result.output).toContain("did work");
	});

	it("fails after 3 reminders when submit_result is never called and no tools run", async () => {
		const session = createMockSession(({ promptIndex, emit, state }) => {
			const assistant = createAssistantStopMessage(
				promptIndex === 1 ? "never used a tool" : "still no submit_result",
			);
			state.messages.push(assistant);
			emit({ type: "message_end", message: assistant });
		});

		(sdkModule.createAgentSession as unknown as { mockResolvedValue: (value: unknown) => void }).mockResolvedValue({
			session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
		});

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-no-work-no-submit-result",
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		});
		expect(result.exitCode).toBe(1);
		expect(result.aborted).toBe(false);
		expect(result.stderr).toBe(SUBAGENT_WARNING_MISSING_SUBMIT_RESULT);
		expect(result.error).toBe(SUBAGENT_WARNING_MISSING_SUBMIT_RESULT);
		expect(result.abortReason).toBeUndefined();
		expect(result.output).toContain(SUBAGENT_WARNING_MISSING_SUBMIT_RESULT);
		expect(result.output).toContain("never used a tool");
	});

	it("surfaces abort reason when submit_result reports aborted status", async () => {
		const session = createMockSession(({ promptIndex, emit, state }) => {
			if (promptIndex === 1) {
				const assistant = createAssistantStopMessage("cannot proceed");
				state.messages.push(assistant);
				emit({ type: "message_end", message: assistant });
			}
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-abort",
				toolName: "submit_result",
				result: {
					content: [{ type: "text", text: "Task aborted: blocked by permissions" }],
					details: { status: "aborted", error: "blocked by permissions" },
				},
				isError: false,
			});
		});

		(sdkModule.createAgentSession as unknown as { mockResolvedValue: (value: unknown) => void }).mockResolvedValue({
			session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
		});

		const result = await runSubprocess({ ...baseOptions, id: "subagent-aborted-submit-result" });
		expect(result.aborted).toBe(true);
		expect(result.abortReason).toBe("blocked by permissions");
	});

	it("forwards auto-retry session events into progress updates", async () => {
		const progressUpdates: AgentProgress[] = [];
		const session = createMockSession(({ emit }) => {
			emit({
				type: "auto_retry_start",
				attempt: 1,
				maxAttempts: 3,
				delayMs: 1_800_000,
				errorMessage: "usage limit reached",
			});
			emit({ type: "auto_retry_end", success: true, attempt: 1 });
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-submit-result-retry",
				toolName: "submit_result",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});

		(sdkModule.createAgentSession as unknown as { mockResolvedValue: (value: unknown) => void }).mockResolvedValue({
			session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
		});

		await runSubprocess({
			...baseOptions,
			id: "subagent-auto-retry-progress",
			onProgress: progress => {
				progressUpdates.push(structuredClone(progress));
			},
		});

		expect(progressUpdates.some(progress => progress.retry?.errorMessage === "usage limit reached")).toBe(true);
		expect(progressUpdates.at(-1)?.retry).toBeUndefined();
	});

	it("preserves pre-submit auth failures instead of rewriting them into missing-submit warnings", async () => {
		const session = createMockSession(({ promptIndex, emit, state }) => {
			if (promptIndex !== 1) return;
			const assistant = createAssistantErrorMessage("401 Invalid bearer token", "delegated model startup failed");
			state.messages.push(assistant);
			emit({ type: "message_end", message: assistant });
		});

		(sdkModule.createAgentSession as unknown as { mockResolvedValue: (value: unknown) => void }).mockResolvedValue({
			session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
		});

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-auth-failure-before-submit-result",
			artifactsDir: "/tmp",
			persistArtifacts: true,
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		});

		expect(result.exitCode).toBe(1);
		expect(result.aborted).toBe(false);
		expect(result.stderr).toBe("401 Invalid bearer token");
		expect(result.error).toBe("401 Invalid bearer token");
		expect(result.output).not.toContain(SUBAGENT_WARNING_MISSING_SUBMIT_RESULT);
		expect(result.sessionId).toBe("mock-subagent-session");
		expect(result.transcriptPath).toBe("/tmp/subagent-auth-failure-before-submit-result.jsonl");
	});

	it("marks pre-aborted subprocess with a concrete reason", async () => {
		const abortController = new AbortController();
		abortController.abort("caller cancelled task");

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-cancelled-before-start",
			signal: abortController.signal,
		});

		expect(result.aborted).toBe(true);
		expect(result.abortReason).toBe("Cancelled before start");
		expect(result.stderr).toBe("Cancelled before start");
	});
});

/**
 * Stream barrier — FEAT-788.
 *
 * When the streamed assistant message emits `toolcall_end` for a tool whose
 * definition declares `executionMode: "sequential"`, the agent loop cuts the
 * SSE at that block:
 *   - assistant message content is trimmed to end at the barrier tool inclusive
 *   - stopReason is forced to `"toolUse"`
 *   - upstream provider stream is best-effort aborted
 *   - downstream consumers see exactly one `message_end` for the cut message
 *
 * Rationale: the model generates tokens autoregressively and cannot see a
 * tool_result mid-message. When it speculates past a state barrier (await,
 * ask, exit_plan_mode, cancel_job, browser) it produces output that reasons
 * against fictitious state. Cutting at the barrier lets the harness execute
 * the deterministic prefix and re-prompt with real context.
 *
 * This file lives next to `agent-loop-execution-mode.test.ts` which covers
 * the post-stream batch-dispatch concurrency contract; the barrier is the
 * complementary mid-stream behaviour.
 */
import { describe, expect, it } from "bun:test";
import { agentLoop } from "@spell/pi-agent-core/agent-loop";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	StreamFn,
} from "@spell/pi-agent-core/types";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Message,
	Model,
	UserMessage,
} from "@spell/pi-ai";
import { AssistantMessageEventStream } from "@spell/pi-ai/utils/event-stream";
import { Type } from "@sinclair/typebox";

// ──────────────────────────────────────────────────────────────────────────────
// Test plumbing
// ──────────────────────────────────────────────────────────────────────────────

function usage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function model(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function userMsg(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

const identity = (messages: AgentMessage[]): Message[] =>
	messages.filter(
		m => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
	) as Message[];

/**
 * Lightweight tool factory. By default the tool's execute() resolves to a
 * one-line text result; if `delayMs` is set it sleeps first so we can assert
 * serial vs parallel ordering. Sequential mode is the only knob the barrier
 * cares about.
 */
interface TestToolOptions {
	name: string;
	executionMode?: "sequential" | "parallel";
	trace?: string[];
	delayMs?: number;
	resultText?: string;
}

function makeTool(opts: TestToolOptions): AgentTool<any, any> {
	const tool: AgentTool<any, any> = {
		name: opts.name,
		label: opts.name,
		description: "test tool",
		parameters: Type.Object({}),
		strict: true,
		execute: async () => {
			opts.trace?.push(`start:${opts.name}`);
			if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
			opts.trace?.push(`end:${opts.name}`);
			return {
				content: [{ type: "text", text: opts.resultText ?? opts.name }],
				details: {},
			};
		},
	};
	if (opts.executionMode) {
		(tool as { executionMode?: "sequential" | "parallel" }).executionMode = opts.executionMode;
	}
	return tool;
}

// ──────────────────────────────────────────────────────────────────────────────
// Scripted stream
// ──────────────────────────────────────────────────────────────────────────────

/**
 * One step the test wants the provider to emit. Combined into a full
 * AssistantMessageEvent[] by `buildEvents`, which threads the partial-message
 * state correctly between deltas.
 */
type Step =
	| { kind: "text"; text: string }
	| { kind: "tool"; id: string; name: string; args?: Record<string, unknown> };

interface ScriptedRun {
	/** Captures whether the provider stream was aborted after the cut. */
	abortedAfterCut: boolean;
	/** All events the provider emitted, including any after the cut (which the
	 *  consumer should NOT propagate). */
	emitted: AssistantMessageEvent[];
}

/**
 * Build a stream-fn that emits the given steps as a sequence of
 * AssistantMessageEvents. The fn also captures the post-cut emission count
 * so tests can confirm the consumer stopped reading after the barrier.
 *
 * The provider receives an AbortSignal via SimpleStreamOptions. When it
 * trips, we stop pushing further events into the stream (mirroring real
 * SDK behaviour where SSE consumers exit their for-await on abort).
 */
function scripted(steps: Step[], runs: ScriptedRun[]): StreamFn {
	return (..._args) => {
		const stream = new AssistantMessageEventStream();
		const run: ScriptedRun = { abortedAfterCut: false, emitted: [] };
		runs.push(run);

		// Pull the signal from the options arg if present. Surface the abort the
		// moment it fires so the test doesn't depend on the IIFE getting another
		// macrotask slice after consumer-side cut.
		const opts = _args[2] as { signal?: AbortSignal } | undefined;
		const signal = opts?.signal;
		signal?.addEventListener("abort", () => {
			run.abortedAfterCut = true;
		});

		(async () => {
			const baseMsg: AssistantMessage = {
				role: "assistant",
				content: [],
				api: "openai-responses",
				provider: "openai",
				model: "mock",
				usage: usage(),
				stopReason: "stop",
				timestamp: Date.now(),
			};

			const push = (ev: AssistantMessageEvent) => {
				if (signal?.aborted) {
					run.abortedAfterCut = true;
					return false;
				}
				run.emitted.push(ev);
				stream.push(ev);
				return true;
			};

			// start
			if (!push({ type: "start", partial: { ...baseMsg } })) return;

			for (let i = 0; i < steps.length; i++) {
				const step = steps[i];
				if (step.kind === "text") {
					baseMsg.content.push({ type: "text", text: step.text });
					const idx = baseMsg.content.length - 1;
					if (!push({ type: "text_start", contentIndex: idx, partial: { ...baseMsg } })) return;
					if (
						!push({
							type: "text_delta",
							contentIndex: idx,
							delta: step.text,
							partial: { ...baseMsg },
						})
					)
						return;
					if (
						!push({
							type: "text_end",
							contentIndex: idx,
							content: step.text,
							partial: { ...baseMsg },
						})
					)
						return;
				} else {
					// tool
					baseMsg.content.push({
						type: "toolCall",
						id: step.id,
						name: step.name,
						arguments: step.args ?? {},
					});
					const idx = baseMsg.content.length - 1;
					if (
						!push({
							type: "toolcall_start",
							contentIndex: idx,
							partial: { ...baseMsg },
						})
					)
						return;
					if (
						!push({
							type: "toolcall_end",
							contentIndex: idx,
							toolCall: {
								type: "toolCall",
								id: step.id,
								name: step.name,
								arguments: step.args ?? {},
							},
							partial: { ...baseMsg },
						})
					)
						return;
					// After every event yield to a macrotask so the consumer has time
					// to drain microtasks (and, if a barrier fired, abort the signal)
					// before we emit the next event. setTimeout(0) is a macrotask boundary
					// while Promise.resolve() is only a microtask — without macrotask
					// yielding our IIFE drains the entire steps list before the consumer
					// processes any event.
					await new Promise<void>(r => setTimeout(r, 0));
					if (signal?.aborted) {
						run.abortedAfterCut = true;
						return;
					}
				}
			}

			baseMsg.stopReason = "toolUse";
			push({ type: "done", reason: "toolUse", message: { ...baseMsg } });
		})();

		return stream;
	};
}

/**
 * Drive a single assistant turn through agentLoop. The provider emits the
 * given `firstTurn` steps; subsequent turns return an empty stop-message so
 * the loop terminates cleanly. Returns the captured agent events plus the
 * provider's emission record.
 */
async function runWithStream(
	firstTurn: Step[],
	tools: AgentTool<any, any>[],
	configOverride?: Partial<AgentLoopConfig>,
): Promise<{ events: AgentEvent[]; runs: ScriptedRun[] }> {
	const ctx: AgentContext = { systemPrompt: "", messages: [], tools };
	const cfg: AgentLoopConfig = {
		model: model(),
		convertToLlm: identity,
		...configOverride,
	};

	const runs: ScriptedRun[] = [];
	let turn = 0;
	const streamFn: StreamFn = (...args) => {
		if (turn === 0) {
			turn++;
			return scripted(firstTurn, runs)(...args);
		}
		// Subsequent turns: empty stop message, no tools.
		turn++;
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			const msg: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				api: "openai-responses",
				provider: "openai",
				model: "mock",
				usage: usage(),
				stopReason: "stop",
				timestamp: Date.now(),
			};
			stream.push({ type: "done", reason: "stop", message: msg });
		});
		return stream;
	};

	const events: AgentEvent[] = [];
	const stream = agentLoop([userMsg("go")], ctx, cfg, undefined, streamFn);
	for await (const ev of stream) events.push(ev);
	await stream.result();
	return { events, runs };
}

// Helpers to extract the assistant message that closed turn 0.
function findFirstAssistantMessageEnd(events: AgentEvent[]): AssistantMessage | undefined {
	for (const ev of events) {
		if (ev.type === "message_end" && ev.message.role === "assistant") {
			return ev.message;
		}
	}
	return undefined;
}

function countMessageEndsForFirstAssistant(events: AgentEvent[]): number {
	const first = findFirstAssistantMessageEnd(events);
	if (!first) return 0;
	return events.filter(
		ev =>
			ev.type === "message_end" &&
			ev.message.role === "assistant" &&
			ev.message.timestamp === first.timestamp,
	).length;
}

function toolCallNames(message: AssistantMessage | undefined): string[] {
	if (!message) return [];
	return message.content
		.filter((c): c is Extract<AssistantMessage["content"][number], { type: "toolCall" }> => c.type === "toolCall")
		.map(c => c.name);
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe("agent-loop stream barrier (FEAT-788)", () => {
	it("cuts at toolcall_end for a sequential tool — content trimmed inclusive", async () => {
		const tools = [
			makeTool({ name: "bash" }),
			makeTool({ name: "await", executionMode: "sequential" }),
		];
		const { events } = await runWithStream(
			[
				{ kind: "text", text: "plan: run ok1, await, run ok2" },
				{ kind: "tool", id: "1", name: "bash", args: { command: "echo ok1" } },
				{ kind: "tool", id: "2", name: "await" },
				{ kind: "tool", id: "3", name: "bash", args: { command: "echo ok2" } },
			],
			tools,
		);

		const first = findFirstAssistantMessageEnd(events);
		expect(first).toBeDefined();
		// Content: text, bash(1), await(2). bash(3) is past the barrier.
		expect(toolCallNames(first)).toEqual(["bash", "await"]);
		// stopReason normalised to toolUse since we cut on a tool block.
		expect(first?.stopReason).toBe("toolUse");
	});

	it("aborts the upstream provider stream after the barrier fires", async () => {
		const tools = [
			makeTool({ name: "bash" }),
			makeTool({ name: "await", executionMode: "sequential" }),
		];
		const { runs } = await runWithStream(
			[
				{ kind: "tool", id: "1", name: "bash" },
				{ kind: "tool", id: "2", name: "await" },
				{ kind: "tool", id: "3", name: "bash" },
			],
			tools,
		);

		// The provider observed an abort during emission. (We yield to
		// microtasks between events so the consumer's abort propagates back
		// before we'd try to push the post-barrier bash(3) tool block.)
		expect(runs[0].abortedAfterCut).toBe(true);
	});

	it("cuts at the FIRST sequential toolcall_end when multiple sequential blocks appear", async () => {
		const tools = [
			makeTool({ name: "await", executionMode: "sequential" }),
			makeTool({ name: "bash" }),
		];
		const { events } = await runWithStream(
			[
				{ kind: "tool", id: "1", name: "await" },
				{ kind: "text", text: "thinking" },
				{ kind: "tool", id: "2", name: "await" },
				{ kind: "tool", id: "3", name: "bash" },
			],
			tools,
		);
		const first = findFirstAssistantMessageEnd(events);
		// Cut on first sequential. Subsequent text + second await + bash(3)
		// were all past the barrier.
		expect(toolCallNames(first)).toEqual(["await"]);
	});

	it("does not trigger when sequentialToolStreamBarrier is off", async () => {
		const tools = [
			makeTool({ name: "bash" }),
			makeTool({ name: "await", executionMode: "sequential" }),
		];
		const { events } = await runWithStream(
			[
				{ kind: "tool", id: "1", name: "bash" },
				{ kind: "tool", id: "2", name: "await" },
				{ kind: "tool", id: "3", name: "bash" },
			],
			tools,
			{ sequentialToolStreamBarrier: "off" },
		);
		const first = findFirstAssistantMessageEnd(events);
		expect(toolCallNames(first)).toEqual(["bash", "await", "bash"]);
	});

	it("does not trigger for purely-parallel batches", async () => {
		const tools = [makeTool({ name: "bash" }), makeTool({ name: "find" })];
		const { events, runs } = await runWithStream(
			[
				{ kind: "tool", id: "1", name: "bash" },
				{ kind: "tool", id: "2", name: "bash" },
				{ kind: "tool", id: "3", name: "bash" },
				{ kind: "tool", id: "4", name: "find" },
			],
			tools,
		);
		const first = findFirstAssistantMessageEnd(events);
		expect(toolCallNames(first)).toEqual(["bash", "bash", "bash", "find"]);
		// Provider was never aborted.
		expect(runs[0].abortedAfterCut).toBe(false);
	});

	it("cuts at the very first block if it's already a sequential tool", async () => {
		const tools = [
			makeTool({ name: "await", executionMode: "sequential" }),
			makeTool({ name: "bash" }),
		];
		const { events } = await runWithStream(
			[
				{ kind: "tool", id: "1", name: "await" },
				{ kind: "tool", id: "2", name: "bash" },
				{ kind: "tool", id: "3", name: "bash" },
			],
			tools,
		);
		const first = findFirstAssistantMessageEnd(events);
		expect(toolCallNames(first)).toEqual(["await"]);
	});

	it("fails open when the tool name is not in the active set", async () => {
		// `await` is referenced by the stream but NOT registered. The barrier
		// can't classify it → full stream is consumed. The agent loop's
		// existing unresolved-tool path then errors on dispatch, but the
		// barrier itself must not pre-trim.
		const tools = [makeTool({ name: "bash" })];
		const { events } = await runWithStream(
			[
				{ kind: "tool", id: "1", name: "bash" },
				{ kind: "tool", id: "2", name: "await" }, // unknown
				{ kind: "tool", id: "3", name: "bash" },
			],
			tools,
		);
		const first = findFirstAssistantMessageEnd(events);
		expect(toolCallNames(first)).toEqual(["bash", "await", "bash"]);
	});

	it("emits exactly one message_end for the cut assistant message", async () => {
		const tools = [
			makeTool({ name: "bash" }),
			makeTool({ name: "await", executionMode: "sequential" }),
		];
		const { events } = await runWithStream(
			[
				{ kind: "tool", id: "1", name: "bash" },
				{ kind: "tool", id: "2", name: "await" },
				{ kind: "tool", id: "3", name: "bash" },
			],
			tools,
		);
		expect(countMessageEndsForFirstAssistant(events)).toBe(1);
	});

	it("integration: after cut, runLoop drives a fresh assistant turn (provider called twice)", async () => {
		// Count provider stream invocations across turns: turn 0 stream is the
		// scripted one with the barrier; turn 1 stream is the empty stop
		// produced by runWithStream's auto-continuation. The fact that the second
		// stream is constructed AT ALL proves runLoop continued past the cut and
		// re-entered streamAssistantResponse.
		let streamInvocations = 0;
		const tools = [
			makeTool({ name: "bash" }),
			makeTool({ name: "await", executionMode: "sequential" }),
		];
		const ctx: AgentContext = { systemPrompt: "", messages: [], tools };
		const cfg: AgentLoopConfig = { model: model(), convertToLlm: identity };

		const runs: ScriptedRun[] = [];
		const streamFn: StreamFn = (...args) => {
			streamInvocations++;
			if (streamInvocations === 1) {
				return scripted(
					[
						{ kind: "tool", id: "1", name: "bash" },
						{ kind: "tool", id: "2", name: "await" },
						{ kind: "tool", id: "3", name: "bash" },
					],
					runs,
				)(...args);
			}
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const msg: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					api: "openai-responses",
					provider: "openai",
					model: "mock",
					usage: usage(),
					stopReason: "stop",
					timestamp: Date.now(),
				};
				stream.push({ type: "done", reason: "stop", message: msg });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userMsg("go")], ctx, cfg, undefined, streamFn);
		for await (const ev of stream) events.push(ev);
		await stream.result();

		// Two stream invocations: cut turn + continuation.
		expect(streamInvocations).toBe(2);
		// Exactly one agent_end at the very tail.
		const agentEnds = events.filter(e => e.type === "agent_end");
		expect(agentEnds.length).toBe(1);
		expect(events[events.length - 1].type).toBe("agent_end");
	});

	it("integration: barrier executes prefix, post-barrier tool never dispatches", async () => {
		const trace: string[] = [];
		const tools = [
			makeTool({ name: "bash", trace, delayMs: 5 }),
			makeTool({ name: "await", executionMode: "sequential", trace, delayMs: 5 }),
		];
		const { events } = await runWithStream(
			[
				{ kind: "tool", id: "1", name: "bash", args: { command: "echo ok1" } },
				{ kind: "tool", id: "2", name: "await" },
				{ kind: "tool", id: "3", name: "bash", args: { command: "echo ok2" } },
			],
			tools,
		);

		// bash(1) + await(2) ran; bash(3) was past the barrier.
		expect(trace).toEqual(["start:bash", "end:bash", "start:await", "end:await"]);

		// tool_result events: exactly two (id=1, id=2).
		const toolResultIds = events
			.filter(
				(e): e is Extract<AgentEvent, { type: "message_end" }> =>
					e.type === "message_end" && e.message.role === "toolResult",
			)
			.map(e => (e.message as { toolCallId: string }).toolCallId);
		expect(toolResultIds).toEqual(["1", "2"]);
	});
});

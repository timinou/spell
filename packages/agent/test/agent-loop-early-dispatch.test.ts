/**
 * Mid-stream early dispatch for parallel tools — BUG-423.
 *
 * The agent loop normally drains the entire assistant SSE before invoking
 * `executeToolCalls`. For a tool-heavy turn (Opus 4.8 routinely emits 30-100
 * tool blocks in one message), this stalls async work — a background bash
 * job emitted as the first tool waits for the whole stream of subsequent
 * tool blocks before it actually starts running.
 *
 * BUG-423: when a parallel-mode tool's `toolcall_end` event fires mid-stream,
 * fire `tool.execute(...)` immediately. The resulting promise runs alongside
 * the rest of the stream. `executeToolCalls` later observes the dispatch via
 * an internal `eagerDispatch` map and awaits the in-flight promise instead
 * of re-running.
 *
 * Sequential tools (ask, await, cancel_job, exit_plan_mode, browser) are
 * never early-dispatched — the FEAT-788 stream barrier cuts the stream at
 * their `toolcall_end` instead. This test file checks the orthogonal half:
 * parallel tools that should NOT wait.
 *
 * Co-locates with agent-loop-stream-barrier.test.ts and
 * agent-loop-execution-mode.test.ts. The same scripted-stream + StreamFn
 * helper pattern is reused.
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
import type { AssistantMessage, AssistantMessageEvent, Message, Model, UserMessage } from "@spell/pi-ai";
import { AssistantMessageEventStream } from "@spell/pi-ai/utils/event-stream";
import { Type } from "@sinclair/typebox";

// ──────────────────────────────────────────────────────────────────────────────
// Plumbing (shared shape with barrier test; kept inline so tests are self-contained)
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

interface ExecutionTrace {
	id: string;
	name: string;
	at: number; // ms since trace start
	phase: "start" | "end";
}

interface TestToolOptions {
	name: string;
	executionMode?: "sequential" | "parallel";
	trace?: ExecutionTrace[];
	traceStart?: { current: number };
	delayMs?: number;
	throws?: string;
	resultText?: string;
}

function makeTool(opts: TestToolOptions): AgentTool<any, any> {
	const traceNow = () => (opts.traceStart ? Date.now() - opts.traceStart.current : Date.now());
	const tool: AgentTool<any, any> = {
		name: opts.name,
		label: opts.name,
		description: "test tool",
		parameters: Type.Object({}),
		strict: true,
		execute: async (id: string) => {
			opts.trace?.push({ id, name: opts.name, at: traceNow(), phase: "start" });
			if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
			if (opts.throws) {
				opts.trace?.push({ id, name: opts.name, at: traceNow(), phase: "end" });
				throw new Error(opts.throws);
			}
			opts.trace?.push({ id, name: opts.name, at: traceNow(), phase: "end" });
			return {
				content: [{ type: "text", text: opts.resultText ?? `${opts.name}:${id}` }],
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

type Step =
	| { kind: "text"; text: string }
	| { kind: "tool"; id: string; name: string; args?: Record<string, unknown> }
	| { kind: "gap"; ms: number }; // wall-clock gap between events

/**
 * Returns a StreamFn that scripts an assistant turn out of `steps`. After each
 * tool event the IIFE yields a macrotask so the consumer's `for await` has a
 * chance to drain (and, for early dispatch, kick off `tool.execute`) before
 * the next event is queued.
 */
function scripted(steps: Step[]): StreamFn {
	return (..._args) => {
		const stream = new AssistantMessageEventStream();
		const opts = _args[2] as { signal?: AbortSignal } | undefined;
		const signal = opts?.signal;

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
				if (signal?.aborted) return false;
				stream.push(ev);
				return true;
			};

			if (!push({ type: "start", partial: { ...baseMsg } })) return;

			for (const step of steps) {
				if (step.kind === "gap") {
					await new Promise<void>(r => setTimeout(r, step.ms));
					continue;
				}
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
					await new Promise<void>(r => setTimeout(r, 0));
					continue;
				}
				// tool
				baseMsg.content.push({
					type: "toolCall",
					id: step.id,
					name: step.name,
					arguments: step.args ?? {},
				});
				const idx = baseMsg.content.length - 1;
				if (!push({ type: "toolcall_start", contentIndex: idx, partial: { ...baseMsg } })) return;
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
				await new Promise<void>(r => setTimeout(r, 0));
				if (signal?.aborted) return;
			}

			baseMsg.stopReason = "toolUse";
			push({ type: "done", reason: "toolUse", message: { ...baseMsg } });
		})();

		return stream;
	};
}

async function runScripted(
	steps: Step[],
	tools: AgentTool<any, any>[],
	configOverride?: Partial<AgentLoopConfig>,
): Promise<{ events: AgentEvent[] }> {
	const ctx: AgentContext = { systemPrompt: "", messages: [], tools };
	const cfg: AgentLoopConfig = { model: model(), convertToLlm: identity, ...configOverride };

	let turn = 0;
	const streamFn: StreamFn = (...args) => {
		if (turn === 0) {
			turn++;
			return scripted(steps)(...args);
		}
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
	return { events };
}

// Helpers for asserting event order
function firstAssistantMessageEnd(events: AgentEvent[]): AssistantMessage | undefined {
	for (const ev of events) {
		if (ev.type === "message_end" && ev.message.role === "assistant") return ev.message;
	}
	return undefined;
}

function eventTimestampForId(events: AgentEvent[], type: AgentEvent["type"], toolCallId: string): number {
	for (let i = 0; i < events.length; i++) {
		const ev = events[i];
		if (ev.type !== type) continue;
		if ("toolCallId" in ev && (ev as { toolCallId?: string }).toolCallId === toolCallId) return i;
		if (
			ev.type === "message_end" &&
			ev.message.role === "toolResult" &&
			(ev.message as { toolCallId: string }).toolCallId === toolCallId
		)
			return i;
	}
	return -1;
}

function indexOfFirst(events: AgentEvent[], pred: (ev: AgentEvent) => boolean): number {
	for (let i = 0; i < events.length; i++) {
		if (pred(events[i])) return i;
	}
	return -1;
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe("agent-loop early dispatch (BUG-423)", () => {
	it("starts a parallel tool's execute() mid-stream — before later toolcall_end events", async () => {
		const traceStart = { current: Date.now() };
		const trace: ExecutionTrace[] = [];
		const tools = [
			makeTool({ name: "bash", trace, traceStart, delayMs: 5 }),
			makeTool({ name: "bash2", trace, traceStart, delayMs: 5 }),
		];
		// Stream emits two parallel bash blocks separated by a long gap. With
		// early dispatch enabled, bash#1's execute fires at its toolcall_end
		// — which happens BEFORE bash#2's toolcall_end (gap ms later). So in
		// the trace, bash#1's "start" must precede bash#2's toolcall_end (and
		// will also precede its "start").
		traceStart.current = Date.now();
		await runScripted(
			[
				{ kind: "tool", id: "1", name: "bash" },
				{ kind: "gap", ms: 50 },
				{ kind: "tool", id: "2", name: "bash2" },
			],
			tools,
		);
		const bash1Start = trace.find(t => t.id === "1" && t.phase === "start");
		const bash2Start = trace.find(t => t.id === "2" && t.phase === "start");
		expect(bash1Start).toBeDefined();
		expect(bash2Start).toBeDefined();
		// bash#1 starts at its toolcall_end; bash#2 starts ~50ms later at its own
		// toolcall_end. With early dispatch, the inter-start gap must reflect the
		// scripted gap, NOT collapse to zero (which is what would happen if both
		// dispatched post-stream).
		const startGapMs = bash2Start!.at - bash1Start!.at;
		expect(startGapMs).toBeGreaterThanOrEqual(40);
		// And bash#1 must NOT have waited for bash#2's toolcall_end — it ran
		// concurrently with the stream. bash#1's run is delayMs=5, so its END
		// happens well before bash#2's START.
		const bash1End = trace.find(t => t.id === "1" && t.phase === "end");
		expect(bash1End).toBeDefined();
		expect(bash1End!.at).toBeLessThan(bash2Start!.at);
	});

	it("emits both tool_results for parallel tools regardless of finish order", async () => {
		// Tool_result emission order within a parallel batch follows COMPLETION
		// order (this is the pre-existing executeToolCalls behaviour). Provider
		// APIs match tool_use_id ↔ tool_use.id by id, not by position, so this is
		// API-safe. Early dispatch inherits the same property: both results land,
		// neither is dropped, and the source-order pairing is preserved by id.
		const tools = [
			makeTool({ name: "slow", delayMs: 30, resultText: "SLOW-RESULT" }),
			makeTool({ name: "fast", delayMs: 1, resultText: "FAST-RESULT" }),
		];
		const { events } = await runScripted(
			[
				{ kind: "tool", id: "1", name: "slow" },
				{ kind: "tool", id: "2", name: "fast" },
			],
			tools,
		);
		const slowResultIdx = eventTimestampForId(events, "message_end", "1");
		const fastResultIdx = eventTimestampForId(events, "message_end", "2");
		expect(slowResultIdx).toBeGreaterThan(-1);
		expect(fastResultIdx).toBeGreaterThan(-1);
		// Fast (id=2) completes first, so emission order is fast → slow.
		expect(fastResultIdx).toBeLessThan(slowResultIdx);
	});

	it("does not early-dispatch sequential tools (FEAT-788 barrier handles them)", async () => {
		const traceStart = { current: Date.now() };
		const trace: ExecutionTrace[] = [];
		const tools = [
			makeTool({ name: "bash", trace, traceStart, delayMs: 5 }),
			makeTool({ name: "await", executionMode: "sequential", trace, traceStart, delayMs: 5 }),
			makeTool({ name: "bash2", trace, traceStart, delayMs: 5 }),
		];
		traceStart.current = Date.now();
		const { events } = await runScripted(
			[
				{ kind: "tool", id: "1", name: "bash" },
				{ kind: "tool", id: "2", name: "await" },
				{ kind: "tool", id: "3", name: "bash2" }, // past the barrier
			],
			tools,
		);
		// bash#1 (parallel) is early-dispatched; await#2 (sequential) is NOT —
		// barrier cuts at it; bash2#3 is past the barrier and never runs.
		const ran = trace.filter(t => t.phase === "start").map(t => t.id);
		expect(ran).toContain("1");
		expect(ran).toContain("2");
		expect(ran).not.toContain("3");
		// Trimmed assistant message must end at the barrier (await).
		const first = firstAssistantMessageEnd(events);
		const names = (first?.content ?? [])
			.filter(c => c.type === "toolCall")
			.map(c => (c as { name: string }).name);
		expect(names).toEqual(["bash", "await"]);
	});

	it("off-mode restores legacy behaviour — all tools dispatch post-stream", async () => {
		const traceStart = { current: Date.now() };
		const trace: ExecutionTrace[] = [];
		const tools = [
			makeTool({ name: "bash", trace, traceStart, delayMs: 5 }),
			makeTool({ name: "bash2", trace, traceStart, delayMs: 5 }),
		];
		traceStart.current = Date.now();
		await runScripted(
			[
				{ kind: "tool", id: "1", name: "bash" },
				{ kind: "gap", ms: 50 },
				{ kind: "tool", id: "2", name: "bash2" },
			],
			tools,
			{ earlyDispatchParallelTools: "off" },
		);
		const bash1Start = trace.find(t => t.id === "1" && t.phase === "start");
		const bash2Start = trace.find(t => t.id === "2" && t.phase === "start");
		expect(bash1Start).toBeDefined();
		expect(bash2Start).toBeDefined();
		// Without early dispatch, BOTH tools are launched post-stream by
		// `executeToolCalls` in parallel — their start timestamps cluster
		// tightly together (no gap), unlike the early-dispatch case where the
		// scripted gap propagates through.
		const startGapMs = Math.abs(bash2Start!.at - bash1Start!.at);
		expect(startGapMs).toBeLessThan(20);
	});

	it("emits exactly one tool_execution_end per tool_use (no double-emit when eager dispatch races executeToolCalls)", async () => {
		const tools = [
			makeTool({ name: "bash", resultText: "ok1" }),
			makeTool({ name: "bash2", resultText: "ok2" }),
		];
		const { events } = await runScripted(
			[
				{ kind: "tool", id: "1", name: "bash" },
				{ kind: "tool", id: "2", name: "bash2" },
			],
			tools,
		);
		const ends = events.filter(
			(ev): ev is Extract<AgentEvent, { type: "tool_execution_end" }> => ev.type === "tool_execution_end",
		);
		const idCounts = ends.reduce<Record<string, number>>((acc, ev) => {
			acc[ev.toolCallId] = (acc[ev.toolCallId] || 0) + 1;
			return acc;
		}, {});
		expect(idCounts).toEqual({ "1": 1, "2": 1 });
	});

	it("propagates tool errors through eager dispatch (single tool_result with isError=true)", async () => {
		const tools = [
			makeTool({ name: "bash", throws: "kaboom" }),
			makeTool({ name: "bash2", resultText: "ok2" }),
		];
		const { events } = await runScripted(
			[
				{ kind: "tool", id: "1", name: "bash" },
				{ kind: "tool", id: "2", name: "bash2" },
			],
			tools,
		);
		const errorResultEvent = events.find(
			ev =>
				ev.type === "message_end" &&
				ev.message.role === "toolResult" &&
				(ev.message as { toolCallId: string }).toolCallId === "1",
		);
		expect(errorResultEvent).toBeDefined();
		const errMsg = errorResultEvent && errorResultEvent.type === "message_end" ? errorResultEvent.message : undefined;
		// Tool failure surfaces via isError + the throw message in the result content
		expect(errMsg && (errMsg as { isError?: boolean }).isError).toBe(true);
		const textBlock = (errMsg as { content: Array<{ type: string; text?: string }> }).content.find(
			c => c.type === "text",
		);
		expect(textBlock?.text).toContain("kaboom");
		// And the sibling tool still produced its result
		const okResultEvent = events.find(
			ev =>
				ev.type === "message_end" &&
				ev.message.role === "toolResult" &&
				(ev.message as { toolCallId: string }).toolCallId === "2",
		);
		expect(okResultEvent).toBeDefined();
	});

	it("tool_execution_start for an early-dispatched tool fires before the next toolcall_end downstream", async () => {
		// The whole point of early dispatch is observable mid-stream: the
		// tool_execution_start event for tool#1 must appear BEFORE tool#2's
		// toolcall_end event.
		//
		// We assert on the AssistantMessageEvent SUB-TYPE carried inside the
		// agent's message_update wrapper, NOT on the live `.message.content`
		// snapshot — the latter is aliased through the underlying assistant
		// message and so mutates as the stream progresses, making content-based
		// peeks misleading. (See the discovery during BUG-423 TDD: a
		// `message_update` event captured at index N may look like it carries a
		// later tool block when read at test time because the content array is
		// the same JS object that the producer kept mutating.)
		const tools = [
			makeTool({ name: "bash", delayMs: 100 }),
			makeTool({ name: "bash2", delayMs: 1 }),
		];
		const { events } = await runScripted(
			[
				{ kind: "tool", id: "1", name: "bash" },
				{ kind: "gap", ms: 30 },
				{ kind: "tool", id: "2", name: "bash2" },
			],
			tools,
		);
		const tool1StartIdx = indexOfFirst(
			events,
			ev => ev.type === "tool_execution_start" && (ev as { toolCallId: string }).toolCallId === "1",
		);
		const tool2ToolcallEndIdx = indexOfFirst(events, ev => {
			if (ev.type !== "message_update") return false;
			const sub = (ev as { assistantMessageEvent: AssistantMessageEvent }).assistantMessageEvent;
			if (sub.type !== "toolcall_end") return false;
			return (sub as { toolCall: { id: string } }).toolCall.id === "2";
		});
		expect(tool1StartIdx).toBeGreaterThan(-1);
		expect(tool2ToolcallEndIdx).toBeGreaterThan(-1);
		expect(tool1StartIdx).toBeLessThan(tool2ToolcallEndIdx);
	});

	it("unknown tool name does not block stream (fail-open, deferred to executeToolCalls error path)", async () => {
		// Tool emitted in the stream but not in context.tools. Early dispatch
		// cannot classify it as parallel → must NOT eagerly dispatch. The
		// post-stream batch dispatch produces an error result as today.
		const tools = [makeTool({ name: "bash", resultText: "ok" })];
		const { events } = await runScripted(
			[
				{ kind: "tool", id: "1", name: "bash" },
				{ kind: "tool", id: "2", name: "ghost" },
			],
			tools,
		);
		const ghostResult = events.find(
			ev =>
				ev.type === "message_end" &&
				ev.message.role === "toolResult" &&
				(ev.message as { toolCallId: string }).toolCallId === "2",
		);
		expect(ghostResult).toBeDefined();
		// Error path: isError true, content mentions the unknown tool name.
		const msg = ghostResult && ghostResult.type === "message_end" ? ghostResult.message : undefined;
		expect(msg && (msg as { isError?: boolean }).isError).toBe(true);
	});
});

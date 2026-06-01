/**
 * Tool-batch concurrency contract.
 *
 * Tools may declare `executionMode: "sequential"` to require batch-wide
 * exclusivity. The agent loop runs the WHOLE batch serially in assistant
 * source order whenever ANY tool in the batch declares it. This protects
 * tools that block on user input (`ask`), are batch sync points (`await`),
 * or mutate the agent's tool set / mode (`exit_plan_mode`).
 *
 * Tools that declare "parallel" (or omit the field) run concurrently with
 * their siblings; nothing changes for the common case.
 */
import { describe, expect, it } from "bun:test";
import { agentLoop } from "@spell/pi-agent-core/agent-loop";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "@spell/pi-agent-core/types";
import type { AssistantMessage, Message, Model, UserMessage } from "@spell/pi-ai";
import { AssistantMessageEventStream } from "@spell/pi-ai/utils/event-stream";
import { Type } from "@sinclair/typebox";

class MockAssistantStream extends AssistantMessageEventStream {}

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

function assistantWithCalls(calls: Array<{ name: string; id: string }>): AssistantMessage {
	return {
		role: "assistant",
		content: calls.map(c => ({ type: "toolCall", id: c.id, name: c.name, arguments: {} })),
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function userMsg(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

const identity = (messages: AgentMessage[]): Message[] =>
	messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];

interface TrackedToolOptions {
	name: string;
	executionMode?: "sequential" | "parallel";
	/** ms to sleep inside execute() so we can observe overlap. */
	delayMs?: number;
	/** When execute() runs, record its start order into this array. */
	trace: string[];
	/** Optional: throw from execute(). */
	throw?: Error;
}

function makeTool(opts: TrackedToolOptions): AgentTool<any, any> {
	const tool: AgentTool<any, any> = {
		name: opts.name,
		label: opts.name,
		description: "test tool",
		parameters: Type.Object({}),
		strict: true,
		execute: async () => {
			opts.trace.push(`start:${opts.name}`);
			if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
			if (opts.throw) {
				opts.trace.push(`throw:${opts.name}`);
				throw opts.throw;
			}
			opts.trace.push(`end:${opts.name}`);
			return { content: [{ type: "text", text: opts.name }], details: {} };
		},
	};
	if (opts.executionMode) {
		(tool as { executionMode?: "sequential" | "parallel" }).executionMode = opts.executionMode;
	}
	return tool;
}

async function runOneBatch(calls: Array<{ name: string; id: string }>, tools: AgentTool<any, any>[]) {
	const ctx: AgentContext = { systemPrompt: "", messages: [], tools };
	const cfg: AgentLoopConfig = { model: model(), convertToLlm: identity };

	let turn = 0;
	const streamFn = () => {
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			const message =
				turn === 0
					? assistantWithCalls(calls)
					: ({
							...assistantWithCalls([]),
							content: [{ type: "text", text: "done" }],
							stopReason: "stop",
						} as AssistantMessage);
			turn++;
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};

	const events: AgentEvent[] = [];
	const stream = agentLoop([userMsg("go")], ctx, cfg, undefined, streamFn);
	for await (const ev of stream) events.push(ev);
	await stream.result();
	return events;
}

describe("agent-loop tool execution mode", () => {
	it("pure-parallel batch overlaps execution (no regression)", async () => {
		const trace: string[] = [];
		const tools = [
			makeTool({ name: "p_a", trace, delayMs: 30 }),
			makeTool({ name: "p_b", trace, delayMs: 30 }),
			makeTool({ name: "p_c", trace, delayMs: 30 }),
		];

		const t0 = Date.now();
		await runOneBatch(
			[
				{ name: "p_a", id: "1" },
				{ name: "p_b", id: "2" },
				{ name: "p_c", id: "3" },
			],
			tools,
		);
		const elapsed = Date.now() - t0;

		// All three started before any finished → overlap.
		const firstEnd = trace.indexOf("end:p_a");
		const otherStartsBeforeFirstEnd = trace.slice(0, firstEnd).filter(t => t.startsWith("start:")).length;
		expect(otherStartsBeforeFirstEnd).toBe(3);
		// 3 × 30ms serial would be ≥90ms; parallel should finish around 30-60ms.
		expect(elapsed).toBeLessThan(80);
	});

	it("any sequential tool forces the WHOLE batch to run in source order", async () => {
		const trace: string[] = [];
		const tools = [
			makeTool({ name: "p_a", trace, delayMs: 20 }),
			// 'seq' is the middle call; it forces the entire batch sequential.
			makeTool({ name: "seq", executionMode: "sequential", trace, delayMs: 20 }),
			makeTool({ name: "p_b", trace, delayMs: 20 }),
		];

		await runOneBatch(
			[
				{ name: "p_a", id: "1" },
				{ name: "seq", id: "2" },
				{ name: "p_b", id: "3" },
			],
			tools,
		);

		// Source order is p_a → seq → p_b; sequential mode means each ends before
		// the next starts.
		expect(trace).toEqual(["start:p_a", "end:p_a", "start:seq", "end:seq", "start:p_b", "end:p_b"]);
	});

	it("sequential tool that throws does not abort the rest", async () => {
		const trace: string[] = [];
		const tools = [
			makeTool({ name: "p_a", trace, delayMs: 10 }),
			makeTool({
				name: "seq",
				executionMode: "sequential",
				trace,
				delayMs: 10,
				throw: new Error("boom"),
			}),
			makeTool({ name: "p_b", trace, delayMs: 10 }),
		];

		const events = await runOneBatch(
			[
				{ name: "p_a", id: "1" },
				{ name: "seq", id: "2" },
				{ name: "p_b", id: "3" },
			],
			tools,
		);

		// All three should have started and the failing one should not poison siblings.
		expect(trace).toContain("start:p_a");
		expect(trace).toContain("throw:seq");
		expect(trace).toContain("start:p_b");
		expect(trace).toContain("end:p_b");

		// Each call produced a toolResult message_end.
		const toolResultEnds = events.filter(
			(e): e is Extract<AgentEvent, { type: "message_end" }> =>
				e.type === "message_end" && e.message.role === "toolResult",
		);
		expect(toolResultEnds.length).toBe(3);
		const errored = toolResultEnds.find(e => (e.message as { toolCallId: string }).toolCallId === "2");
		expect((errored?.message as { isError?: boolean })?.isError).toBe(true);
	});

	it("absence of executionMode keeps default parallel behaviour", async () => {
		const trace: string[] = [];
		const tools = [makeTool({ name: "p_a", trace, delayMs: 25 }), makeTool({ name: "p_b", trace, delayMs: 25 })];
		const t0 = Date.now();
		await runOneBatch(
			[
				{ name: "p_a", id: "1" },
				{ name: "p_b", id: "2" },
			],
			tools,
		);
		expect(Date.now() - t0).toBeLessThan(60);
		// Both started before either ended.
		expect(trace.slice(0, 2).every(t => t.startsWith("start:"))).toBe(true);
	});
});

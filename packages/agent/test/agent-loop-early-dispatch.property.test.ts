/**
 * Property-based tests for early dispatch — BUG-423.
 *
 * `agent-loop-early-dispatch.test.ts` proves the happy path; this file
 * stress-tests the invariants across randomised scenarios. Each scenario
 * is generated from a seeded PRNG so failures reproduce deterministically:
 * the first line of any failure includes the seed, so you can re-run a
 * single offender with `PROP_SEED=<n>`.
 *
 * Invariants checked:
 *   I1 — no duplicate `tool_execution_end` per toolCallId
 *   I2 — every parallel tool block in the trimmed assistant message
 *        produces exactly one `tool_result` message
 *   I3 — `tool_result` count ≤ toolCall count in the final assistant message
 *   I4 — barrier cut: if a sequential tool appears, the trimmed message ends
 *        at its inclusive position; tools past the barrier do NOT execute
 *   I5 — enforce-mode + parallel + scripted gap ⇒ tool's execute starts
 *        BEFORE the next toolcall_end event (the whole point of BUG-423)
 *   I6 — enforce vs off produce the same SET of executed tool ids
 *        (the set is barrier-determined, not dispatch-policy-determined)
 *   I7 — tool_result.content matches the producing tool's expected text
 *   I8 — the agent loop always emits an `agent_end` (no hang / no crash)
 *
 * The scenario generator avoids:
 *   - sequential tools with delayMs > stream completion (they'd hang the test)
 *   - more than one sequential tool (barrier cuts at the first, downstream
 *     ones are guaranteed unreachable; testing them is uninteresting and
 *     complicates the "set of executed ids" comparison)
 *   - tools whose name collides with the registry (the registry uses unique
 *     names per scenario; the stream emits only registered names)
 */
import { describe, expect, it } from "bun:test";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	StreamFn,
} from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage, AssistantMessageEvent, Message, Model, UserMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { Type } from "@sinclair/typebox";

// ──────────────────────────────────────────────────────────────────────────────
// Seeded PRNG (mulberry32 — small, fast, deterministic)
// ──────────────────────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface Rng {
	next: () => number;
	int: (lo: number, hi: number) => number; // inclusive
	pick: <T>(xs: readonly T[]) => T;
	bool: (p?: number) => boolean;
}

function rng(seed: number): Rng {
	const next = mulberry32(seed);
	return {
		next,
		int: (lo, hi) => Math.floor(next() * (hi - lo + 1)) + lo,
		pick: xs => xs[Math.floor(next() * xs.length)],
		bool: (p = 0.5) => next() < p,
	};
}

// ──────────────────────────────────────────────────────────────────────────────
// Plumbing (shared minimal shape — same defaults as the focussed test file)
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

// ──────────────────────────────────────────────────────────────────────────────
// Scenario generator
// ──────────────────────────────────────────────────────────────────────────────

type StepKind = "tool" | "text" | "gap";
type Step =
	| { kind: "text"; text: string }
	| { kind: "tool"; id: string; name: string }
	| { kind: "gap"; ms: number };

interface ToolSpec {
	name: string;
	executionMode: "parallel" | "sequential";
	delayMs: number;
	resultText: string;
	throws?: string;
}

interface Scenario {
	seed: number;
	tools: ToolSpec[];
	steps: Step[];
	/** Subset of `steps` that are `kind: "tool"`, in order. Cached for speed. */
	toolSteps: Array<{ id: string; name: string; stepIndex: number; gapBefore: number }>;
}

function genScenario(seed: number): Scenario {
	const r = rng(seed);
	const toolCount = r.int(1, 6);
	const tools: ToolSpec[] = [];
	for (let i = 0; i < toolCount; i++) {
		// Most tools parallel; rare sequential
		const executionMode: "parallel" | "sequential" = r.bool(0.85) ? "parallel" : "sequential";
		tools.push({
			name: `t${i}`,
			executionMode,
			delayMs: r.int(0, 8),
			resultText: `RESULT-t${i}`,
			throws: r.bool(0.1) ? `boom-t${i}` : undefined,
		});
	}
	// Ensure at most one sequential tool — barrier semantics make further
	// sequential tools unreachable, complicating the executed-set invariant.
	let seenSequential = false;
	for (const t of tools) {
		if (t.executionMode === "sequential") {
			if (seenSequential) t.executionMode = "parallel";
			seenSequential = true;
		}
	}

	const stepCount = r.int(toolCount, toolCount + 8);
	const steps: Step[] = [];
	const toolSteps: Scenario["toolSteps"] = [];
	let nextToolIdx = 0;
	let gapAccum = 0;
	for (let s = 0; s < stepCount; s++) {
		// Insert remaining tools deterministically toward the end; mostly random.
		const remainingTools = toolCount - nextToolIdx;
		const remainingSteps = stepCount - s;
		const forceTool = remainingSteps <= remainingTools;
		const kind: StepKind = forceTool ? "tool" : r.pick<StepKind>(["tool", "text", "gap"]);
		if (kind === "tool" && nextToolIdx < toolCount) {
			const id = `tc${nextToolIdx + 1}`;
			const tname = tools[nextToolIdx].name;
			steps.push({ kind: "tool", id, name: tname });
			toolSteps.push({ id, name: tname, stepIndex: s, gapBefore: gapAccum });
			gapAccum = 0;
			nextToolIdx++;
		} else if (kind === "gap") {
			const ms = r.int(5, 30);
			steps.push({ kind: "gap", ms });
			gapAccum += ms;
		} else {
			steps.push({ kind: "text", text: `chunk-${s}` });
		}
	}
	return { seed, tools, steps, toolSteps };
}

// ──────────────────────────────────────────────────────────────────────────────
// Tool factory + scripted stream (same shape as the focussed test)
// ──────────────────────────────────────────────────────────────────────────────

interface ExecutionTrace {
	id: string;
	name: string;
	at: number;
	phase: "start" | "end";
}

function makeTool(spec: ToolSpec, trace: ExecutionTrace[], traceStart: { current: number }): AgentTool<any, any> {
	const traceNow = () => Date.now() - traceStart.current;
	const t: AgentTool<any, any> = {
		name: spec.name,
		label: spec.name,
		description: "test tool",
		parameters: Type.Object({}),
		strict: true,
		execute: async (id: string) => {
			trace.push({ id, name: spec.name, at: traceNow(), phase: "start" });
			if (spec.delayMs) await new Promise(r => setTimeout(r, spec.delayMs));
			if (spec.throws) {
				trace.push({ id, name: spec.name, at: traceNow(), phase: "end" });
				throw new Error(spec.throws);
			}
			trace.push({ id, name: spec.name, at: traceNow(), phase: "end" });
			return { content: [{ type: "text", text: spec.resultText }], details: {} };
		},
	};
	if (spec.executionMode) {
		(t as { executionMode?: "parallel" | "sequential" }).executionMode = spec.executionMode;
	}
	return t;
}

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
					if (signal?.aborted) return;
					continue;
				}
				if (step.kind === "text") {
					baseMsg.content.push({ type: "text", text: step.text });
					const idx = baseMsg.content.length - 1;
					if (!push({ type: "text_start", contentIndex: idx, partial: { ...baseMsg } })) return;
					if (!push({ type: "text_delta", contentIndex: idx, delta: step.text, partial: { ...baseMsg } })) return;
					if (!push({ type: "text_end", contentIndex: idx, content: step.text, partial: { ...baseMsg } })) return;
					await new Promise<void>(r => setTimeout(r, 0));
					continue;
				}
				baseMsg.content.push({ type: "toolCall", id: step.id, name: step.name, arguments: {} });
				const idx = baseMsg.content.length - 1;
				if (!push({ type: "toolcall_start", contentIndex: idx, partial: { ...baseMsg } })) return;
				if (
					!push({
						type: "toolcall_end",
						contentIndex: idx,
						toolCall: { type: "toolCall", id: step.id, name: step.name, arguments: {} },
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

interface RunResult {
	events: AgentEvent[];
	trace: ExecutionTrace[];
	traceStart: number;
}

async function runScenario(scenario: Scenario, mode: "enforce" | "off"): Promise<RunResult> {
	const trace: ExecutionTrace[] = [];
	const traceStart = { current: Date.now() };
	const tools = scenario.tools.map(spec => makeTool(spec, trace, traceStart));
	const ctx: AgentContext = { systemPrompt: "", messages: [], tools };
	const cfg: AgentLoopConfig = {
		model: model(),
		convertToLlm: identity,
		earlyDispatchParallelTools: mode,
	};

	let turn = 0;
	const streamFn: StreamFn = (...args) => {
		if (turn === 0) {
			turn++;
			return scripted(scenario.steps)(...args);
		}
		turn++;
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					api: "openai-responses",
					provider: "openai",
					model: "mock",
					usage: usage(),
					stopReason: "stop",
					timestamp: Date.now(),
				} as AssistantMessage,
			});
		});
		return stream;
	};

	const events: AgentEvent[] = [];
	const stream = agentLoop([userMsg("go")], ctx, cfg, undefined, streamFn);
	traceStart.current = Date.now();
	for await (const ev of stream) events.push(ev);
	await stream.result();
	return { events, trace, traceStart: traceStart.current };
}

// ──────────────────────────────────────────────────────────────────────────────
// Invariant checks
// ──────────────────────────────────────────────────────────────────────────────

function firstAssistantMessageEnd(events: AgentEvent[]): AssistantMessage | undefined {
	for (const ev of events) {
		if (ev.type === "message_end" && ev.message.role === "assistant") return ev.message;
	}
	return undefined;
}

function trimmedToolCallIds(events: AgentEvent[]): string[] {
	const msg = firstAssistantMessageEnd(events);
	if (!msg) return [];
	return msg.content
		.filter((c): c is Extract<AssistantMessage["content"][number], { type: "toolCall" }> => c.type === "toolCall")
		.map(c => c.id);
}

function executedIds(trace: ExecutionTrace[]): Set<string> {
	const ids = new Set<string>();
	for (const t of trace) if (t.phase === "start") ids.add(t.id);
	return ids;
}

function toolExecutionEndCounts(events: AgentEvent[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const ev of events) {
		if (ev.type !== "tool_execution_end") continue;
		const id = (ev as { toolCallId: string }).toolCallId;
		counts.set(id, (counts.get(id) ?? 0) + 1);
	}
	return counts;
}

function toolResultsById(events: AgentEvent[]): Map<string, { content: string; isError: boolean }> {
	const m = new Map<string, { content: string; isError: boolean }>();
	for (const ev of events) {
		if (ev.type !== "message_end") continue;
		const msg = ev.message;
		if (msg.role !== "toolResult") continue;
		const id = (msg as { toolCallId: string }).toolCallId;
		const text = msg.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("");
		m.set(id, { content: text, isError: !!(msg as { isError?: boolean }).isError });
	}
	return m;
}

function hasAgentEnd(events: AgentEvent[]): boolean {
	return events.some(ev => ev.type === "agent_end");
}

interface InvariantViolation {
	name: string;
	message: string;
}

function checkInvariants(scenario: Scenario, mode: "enforce" | "off", result: RunResult): InvariantViolation[] {
	const violations: InvariantViolation[] = [];

	// I8 — agent_end always emitted
	if (!hasAgentEnd(result.events)) {
		violations.push({ name: "I8", message: "no agent_end event emitted" });
	}

	// I1 — no duplicate tool_execution_end
	for (const [id, count] of toolExecutionEndCounts(result.events)) {
		if (count !== 1) violations.push({ name: "I1", message: `tool ${id} got ${count} tool_execution_end events` });
	}

	// Determine the expected set of executed ids: every toolCall up to and
	// INCLUDING the first sequential tool (barrier inclusive).
	const expectedSet = new Set<string>();
	for (const ts of scenario.toolSteps) {
		expectedSet.add(ts.id);
		const spec = scenario.tools.find(t => t.name === ts.name);
		if (spec?.executionMode === "sequential") break;
	}

	// I4 — trimmed assistant message ends at the barrier inclusive
	const trimmed = trimmedToolCallIds(result.events);
	const trimmedSet = new Set(trimmed);
	for (const id of expectedSet) {
		if (!trimmedSet.has(id)) {
			violations.push({ name: "I4", message: `expected tool ${id} in trimmed message, missing` });
		}
	}
	for (const id of trimmedSet) {
		if (!expectedSet.has(id)) {
			violations.push({ name: "I4", message: `unexpected tool ${id} in trimmed message (past barrier)` });
		}
	}

	// I3 — tool_result count ≤ tool_use count in trimmed message
	const results = toolResultsById(result.events);
	if (results.size > trimmed.length) {
		violations.push({
			name: "I3",
			message: `${results.size} tool_results for ${trimmed.length} toolCalls (over-emit)`,
		});
	}

	// I2 — every parallel tool block in trimmed message produces a tool_result
	for (const id of trimmed) {
		if (!results.has(id)) {
			violations.push({ name: "I2", message: `tool ${id} in trimmed message has no tool_result` });
		}
	}

	// I7 — tool_result.content matches producing tool's expected text/error
	for (const ts of scenario.toolSteps) {
		if (!trimmedSet.has(ts.id)) continue; // past barrier; no result expected
		const spec = scenario.tools.find(t => t.name === ts.name);
		const res = results.get(ts.id);
		if (!spec || !res) continue;
		if (spec.throws) {
			if (!res.isError) violations.push({ name: "I7", message: `tool ${ts.id} should have isError=true` });
			if (!res.content.includes(spec.throws))
				violations.push({ name: "I7", message: `tool ${ts.id} error content missing "${spec.throws}"` });
		} else {
			if (res.isError) violations.push({ name: "I7", message: `tool ${ts.id} should not be error` });
			if (res.content !== spec.resultText)
				violations.push({
					name: "I7",
					message: `tool ${ts.id} content="${res.content}" expected "${spec.resultText}"`,
				});
		}
	}

	// I5 (enforce-mode only) — when there's a real gap before a parallel
	// tool, its execute STARTS before the next toolcall_end events arrive.
	if (mode === "enforce") {
		// Find the first parallel tool with a gap-following neighbour and
		// assert its execute fires concurrently with later stream activity.
		for (let i = 0; i < scenario.toolSteps.length - 1; i++) {
			const cur = scenario.toolSteps[i];
			const next = scenario.toolSteps[i + 1];
			const curSpec = scenario.tools.find(t => t.name === cur.name);
			const nextSpec = scenario.tools.find(t => t.name === next.name);
			if (!curSpec || !nextSpec) continue;
			if (curSpec.executionMode !== "parallel") continue;
			if (curSpec.throws) continue; // throw races make timing fragile
			if (next.gapBefore < 15) continue; // need a real gap
			// cur should execute concurrent with next's scripted gap; thus its
			// start trace time should be < next's start trace time (with margin).
			const curStart = result.trace.find(t => t.id === cur.id && t.phase === "start");
			const nextStart = result.trace.find(t => t.id === next.id && t.phase === "start");
			if (!curStart || !nextStart) continue;
			// Allow 5ms scheduler slop. Difference should reflect the gap.
			const diff = nextStart.at - curStart.at;
			if (diff < next.gapBefore - 10) {
				violations.push({
					name: "I5",
					message: `tool ${cur.id} (gap-prefixed by ${next.gapBefore}ms) did NOT start early: gap-to-next=${diff}ms`,
				});
			}
			break;
		}
	}

	return violations;
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

const PROPERTY_RUNS = Number(process.env.PROP_RUNS ?? 50);
const FIXED_SEED = process.env.PROP_SEED ? Number(process.env.PROP_SEED) : undefined;
const BASE_SEED = 0xb16b00b5;

function reportViolations(seed: number, mode: string, scenario: Scenario, vs: InvariantViolation[]): string {
	const lines = [
		`seed=${seed} mode=${mode}`,
		`tools: ${scenario.tools.map(t => `${t.name}[${t.executionMode},d=${t.delayMs}${t.throws ? ",throws" : ""}]`).join(" ")}`,
		`steps: ${scenario.steps.map(s => (s.kind === "tool" ? `tool(${s.id}=${s.name})` : s.kind === "gap" ? `gap(${s.ms})` : `text`)).join(" ")}`,
		"violations:",
		...vs.map(v => `  ${v.name}: ${v.message}`),
	];
	return lines.join("\n");
}

describe("agent-loop early dispatch — property tests (BUG-423)", () => {
	const seeds: number[] = FIXED_SEED !== undefined
		? [FIXED_SEED]
		: Array.from({ length: PROPERTY_RUNS }, (_, i) => (BASE_SEED + i * 0x9e3779b1) >>> 0);

	for (const seed of seeds) {
		it(`enforce-mode invariants hold for scenario seed=${seed}`, async () => {
			const scenario = genScenario(seed);
			const result = await runScenario(scenario, "enforce");
			const vs = checkInvariants(scenario, "enforce", result);
			if (vs.length > 0) {
				throw new Error(reportViolations(seed, "enforce", scenario, vs));
			}
		});

		it(`off-mode invariants hold for scenario seed=${seed}`, async () => {
			const scenario = genScenario(seed);
			const result = await runScenario(scenario, "off");
			const vs = checkInvariants(scenario, "off", result);
			if (vs.length > 0) {
				throw new Error(reportViolations(seed, "off", scenario, vs));
			}
		});

		it(`enforce vs off agree on executed-id set for scenario seed=${seed}`, async () => {
			const scenario = genScenario(seed);
			const [a, b] = await Promise.all([runScenario(scenario, "enforce"), runScenario(scenario, "off")]);
			const setA = executedIds(a.trace);
			const setB = executedIds(b.trace);
			const sortedA = [...setA].sort();
			const sortedB = [...setB].sort();
			if (sortedA.join(",") !== sortedB.join(",")) {
				throw new Error(
					[
						`I6 violation: enforce vs off disagree on executed set (seed=${seed})`,
						`enforce: [${sortedA.join(",")}]`,
						`off:     [${sortedB.join(",")}]`,
						`scenario: ${scenario.steps.map(s => (s.kind === "tool" ? `${s.id}=${s.name}` : s.kind)).join(" ")}`,
					].join("\n"),
				);
			}
			// Both produce identical results-by-id and identical trimmed messages.
			const resA = toolResultsById(a.events);
			const resB = toolResultsById(b.events);
			expect([...resA.keys()].sort()).toEqual([...resB.keys()].sort());
			expect(trimmedToolCallIds(a.events)).toEqual(trimmedToolCallIds(b.events));
		});
	}
});

/**
 * Unit tests for the PtcRuntime tool dispatcher (bridge Node half).
 */

import { describe, expect, it } from "bun:test";
import type { AgentToolResult } from "@spell/pi-agent-core";
import { PERMISSIVE_POLICY } from "./policy";
import {
	DEFAULT_DENYLIST,
	type DispatchableTool,
	lookupFromMap,
	makeToolDispatcher,
	resultToValue,
	ToolNotAvailableError,
} from "./tool-dispatch";

// Dispatcher mechanics tests use a permissive policy; the read+write DEFAULT
// policy + effect tags are exercised in policy.test.ts.
const anyEffect = { policy: PERMISSIVE_POLICY };

function textResult(text: string): AgentToolResult {
	return { content: [{ type: "text", text }], data: null };
}

/** A fake tool that records calls and returns a fixed result. */
function fakeTool(name: string, result: AgentToolResult | ((args: unknown) => AgentToolResult)): DispatchableTool {
	return {
		name,
		async execute(_id, params) {
			return typeof result === "function" ? result(params) : result;
		},
	};
}

describe("resultToValue", () => {
	it("returns data verbatim when present", () => {
		const r: AgentToolResult = { content: [{ type: "text", text: "ignored" }], details: { items: [1, 2, 3] }, data: { items: [1, 2, 3] } };
		expect(resultToValue(r)).toEqual({ items: [1, 2, 3] });
	});

	it("returns data when present", () => {
		const r: AgentToolResult = {
			content: [
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
			],
			data: "ab",
		};
		expect(resultToValue(r)).toBe("ab");
	});

	it("throws on isError, surfacing the text", () => {
		const r: AgentToolResult = { content: [{ type: "text", text: "boom" }], isError: true, data: null };
		expect(() => resultToValue(r)).toThrow(/boom/);
	});

	it("returns null when only images and no data", () => {
		const r: AgentToolResult = {
			content: [
				{ type: "image", data: "xxx", mimeType: "image/png" },
				{ type: "image", data: "yyy", mimeType: "image/png" },
			],
			data: null,
		};
		expect(resultToValue(r)).toBeNull();
	});

	it("returns data even when text exists", () => {
		const r: AgentToolResult = { content: [{ type: "text", text: "t" }], details: 42, data: 42 };
		expect(resultToValue(r)).toBe(42);
	});

	it("returns null for empty content when no data", () => {
		expect(resultToValue({ content: [], data: null })).toBeNull();
	});
});

describe("makeToolDispatcher", () => {
	it("resolves, executes, and returns the converted value", async () => {
		const tools = new Map<string, DispatchableTool>([
			["org", fakeTool("org", { content: [], details: { open: 5 }, data: { open: 5 } })],
		]);
		const dispatch = makeToolDispatcher({ lookup: lookupFromMap(tools), ...anyEffect });
		await expect(dispatch({ tool: "org", args: { command: "query" } })).resolves.toEqual({ open: 5 });
	});

	it("passes args through to the tool", async () => {
		let seen: unknown;
		const tools = new Map<string, DispatchableTool>([
			[
				"echo",
				{
					name: "echo",
					async execute(_id, params) {
						seen = params;
						return textResult("ok");
					},
				},
			],
		]);
		const dispatch = makeToolDispatcher({ lookup: lookupFromMap(tools), ...anyEffect });
		await dispatch({ tool: "echo", args: { a: 1, b: "two" } });
		expect(seen).toEqual({ a: 1, b: "two" });
	});

	it("throws ToolNotAvailableError for unknown tools", async () => {
		const dispatch = makeToolDispatcher({ lookup: () => undefined, ...anyEffect });
		await expect(dispatch({ tool: "nope", args: {} })).rejects.toBeInstanceOf(ToolNotAvailableError);
	});

	it("propagates tool errors as thrown errors (sandbox surfaces them)", async () => {
		const tools = new Map<string, DispatchableTool>([
			["bad", fakeTool("bad", { content: [{ type: "text", text: "kaboom" }], isError: true, data: null })],
		]);
		const dispatch = makeToolDispatcher({ lookup: lookupFromMap(tools), ...anyEffect });
		await expect(dispatch({ tool: "bad", args: {} })).rejects.toThrow(/kaboom/);
	});

	it("gives each call a unique toolCallId", async () => {
		const ids: string[] = [];
		const tools = new Map<string, DispatchableTool>([
			[
				"t",
				{
					name: "t",
					async execute(id) {
						ids.push(id);
						return textResult("");
					},
				},
			],
		]);
		const dispatch = makeToolDispatcher({ lookup: lookupFromMap(tools), idPrefix: "x", ...anyEffect });
		await dispatch({ tool: "t", args: {} });
		await dispatch({ tool: "t", args: {} });
		expect(ids).toHaveLength(2);
		expect(ids[0]).not.toBe(ids[1]);
		expect(ids[0]).toStartWith("x-t-");
	});
});

describe("lookupFromMap denylist", () => {
	it("denies the default-denied tools even if present in the map", () => {
		const tools = new Map<string, DispatchableTool>([["execute", fakeTool("execute", textResult("x"))]]);
		const lookup = lookupFromMap(tools);
		expect(lookup("execute")).toBeUndefined();
	});

	it("blocks recursion, interactive, and completion tools by default", () => {
		for (const name of ["execute", "ask", "exit_plan_mode", "resolve", "submit_result"]) {
			expect(DEFAULT_DENYLIST.has(name)).toBe(true);
		}
	});

	it("structurally denies agent-state / escalation tools (Review Gate 3, P2)", () => {
		// These must be denied independent of effect tag / policy, because they
		// re-enter the agent loop, mutate session state, or could self-escalate.
		for (const name of [
			"approvals",
			"checkpoint",
			"rewind",
			"cancel_job",
			"await",
			"goals",
			"canvas",
			"canvas_cast",
		]) {
			expect(DEFAULT_DENYLIST.has(name)).toBe(true);
		}
	});

	it("allows a custom denylist", () => {
		const tools = new Map<string, DispatchableTool>([["bash", fakeTool("bash", textResult("x"))]]);
		const lookup = lookupFromMap(tools, new Set(["bash"]));
		expect(lookup("bash")).toBeUndefined();
	});
});

describe("per-execute signal threading (PLAN-324)", () => {
	it("passes the per-call signal from the client to the tool execute", async () => {
		let seen: AbortSignal | undefined;
		const tools = new Map<string, DispatchableTool>([
			[
				"t",
				{
					name: "t",
					async execute(_id, _params, signal) {
						seen = signal;
						return textResult("ok");
					},
				},
			],
		]);
		const dispatch = makeToolDispatcher({ lookup: lookupFromMap(tools), ...anyEffect });
		const perCall = new AbortController();
		await dispatch({ tool: "t", args: {} }, perCall.signal);
		expect(seen).toBeDefined();
		perCall.abort();
		expect(seen?.aborted).toBe(true);
	});

	it("composes the dispatch-level signal with the per-call signal (either aborts)", async () => {
		let seen: AbortSignal | undefined;
		const tools = new Map<string, DispatchableTool>([
			[
				"t",
				{
					name: "t",
					async execute(_id, _params, signal) {
						seen = signal;
						return textResult("ok");
					},
				},
			],
		]);
		const dispatchLevel = new AbortController();
		const dispatch = makeToolDispatcher({ lookup: lookupFromMap(tools), signal: dispatchLevel.signal, ...anyEffect });
		await dispatch({ tool: "t", args: {} }, new AbortController().signal);
		expect(seen?.aborted).toBe(false);
		dispatchLevel.abort();
		expect(seen?.aborted).toBe(true);
	});
});

describe("task is structurally denylisted (PLAN-323 transitive recursion)", () => {
	it("denies 'task' — a program cannot spawn subagents that re-enter execute", () => {
		expect(DEFAULT_DENYLIST.has("task")).toBe(true);
	});
});

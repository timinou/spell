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
	return { content: [{ type: "text", text }] };
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
	it("returns structured details verbatim when present", () => {
		const r: AgentToolResult = { content: [{ type: "text", text: "ignored" }], details: { items: [1, 2, 3] } };
		expect(resultToValue(r)).toEqual({ items: [1, 2, 3] });
	});

	it("joins text blocks when no details", () => {
		const r: AgentToolResult = { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] };
		expect(resultToValue(r)).toBe("ab");
	});

	it("throws on isError, surfacing the text", () => {
		const r: AgentToolResult = { content: [{ type: "text", text: "boom" }], isError: true };
		expect(() => resultToValue(r)).toThrow(/boom/);
	});

	it("returns an image marker when only images are present", () => {
		const r: AgentToolResult = {
			content: [
				{ type: "image", data: "xxx", mimeType: "image/png" },
				{ type: "image", data: "yyy", mimeType: "image/png" },
			],
		};
		expect(resultToValue(r)).toEqual({ _images: 2 });
	});

	it("prefers details even when isError is false and text exists", () => {
		const r: AgentToolResult = { content: [{ type: "text", text: "t" }], details: 42 };
		expect(resultToValue(r)).toBe(42);
	});

	it("handles empty content as empty string", () => {
		expect(resultToValue({ content: [] })).toBe("");
	});
});

describe("makeToolDispatcher", () => {
	it("resolves, executes, and returns the converted value", async () => {
		const tools = new Map<string, DispatchableTool>([["org", fakeTool("org", { content: [], details: { open: 5 } })]]);
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
			["bad", fakeTool("bad", { content: [{ type: "text", text: "kaboom" }], isError: true })],
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

	it("allows a custom denylist", () => {
		const tools = new Map<string, DispatchableTool>([["bash", fakeTool("bash", textResult("x"))]]);
		const lookup = lookupFromMap(tools, new Set(["bash"]));
		expect(lookup("bash")).toBeUndefined();
	});
});

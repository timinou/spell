/**
 * Execute round-trip: the focused proof that a program goes in and a
 * signature-validated value comes out, with tool callbacks and recoverable
 * errors. Runs against a REAL BEAM (skipped when the runtime isn't built).
 *
 * Complements client.test.ts (protocol unit tests over a fake transport) and
 * client.integration.test.ts (broader seam coverage) by pinning the
 * execute contract specifically.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { PtcRuntimeClient, PtcRuntimeError, spawnTransport } from "./client";
import { PERMISSIVE_POLICY } from "./policy";
import { type DispatchableTool, lookupFromMap, makeToolDispatcher } from "./tool-dispatch";

const runtimeDir = path.resolve(import.meta.dirname, "..", "..", "..", "..", "..", "beam", "ptc_runtime");
const runnable =
	spawnSync("mix", ["--version"], { stdio: "ignore" }).status === 0 && existsSync(path.join(runtimeDir, "_build"));
const d = runnable ? describe : describe.skip;

function client(tools: Map<string, DispatchableTool> = new Map()) {
	const { transport } = spawnTransport({ runtimeDir });
	return new PtcRuntimeClient({
		transport,
		onToolCall: makeToolDispatcher({ lookup: lookupFromMap(tools), policy: PERMISSIVE_POLICY }),
	});
}

d("execute round-trip", () => {
	it("program in → value out", async () => {
		const c = client();
		try {
			await c.init({ tools: [] });
			await expect(c.execute({ program: "(reduce + 0 [1 2 3 4])" })).resolves.toBe(10);
		} finally {
			c.close();
		}
	}, 60_000);

	it("signature validates and shapes the return", async () => {
		const c = client();
		try {
			await c.init({ tools: [] });
			const r = await c.execute({
				program: "(let [xs data/xs] {:n (count xs) :sum (reduce + 0 xs)})",
				context: { xs: [10, 20, 30] },
				signature: "{n :int, sum :int}",
			});
			expect(r).toEqual({ n: 3, sum: 60 });
		} finally {
			c.close();
		}
	}, 60_000);

	it("tool callback value flows into the program", async () => {
		const tools = new Map<string, DispatchableTool>([
			[
				"nums",
				{
					name: "nums",
					async execute() {
						return { content: [], details: [1, 2, 3, 4, 5], data: [1, 2, 3, 4, 5] };
					},
				},
			],
		]);
		const c = client(tools);
		try {
			await c.init({ tools: [{ name: "nums" }] });
			const r = await c.execute({ program: "(reduce + 0 (tool/nums {}))" });
			expect(r).toBe(15);
		} finally {
			c.close();
		}
	}, 60_000);

	it("a sandbox error is a recoverable PtcRuntimeError; runtime survives", async () => {
		const c = client();
		try {
			await c.init({ tools: [] });
			await expect(c.execute({ program: "(loop [i 0] (recur (inc i)))", timeoutMs: 200 })).rejects.toBeInstanceOf(
				PtcRuntimeError,
			);
			// Still usable.
			await expect(c.execute({ program: "(+ 1 1)" })).resolves.toBe(2);
		} finally {
			c.close();
		}
	}, 60_000);

	it("non-ASCII returns byte-identical (no latin1 mojibake on the wire) — BUG-464", async () => {
		const c = client();
		try {
			await c.init({ tools: [] });
			// Bare string return: em-dash, ellipsis, arrow — all U+20xx (UTF-8 3-byte).
			await expect(c.execute({ program: '"—…→"' })).resolves.toBe("—…→");
			// Embedded in a map value + key, plus an accented latin1-range char and CJK.
			await expect(c.execute({ program: '{:label "café → 日本語"}' })).resolves.toEqual({ label: "café → 日本語" });
			// Inbound round-trip: a non-ASCII string passed via context returns intact.
			await expect(c.execute({ program: "data/s", context: { s: "—…→" } })).resolves.toBe("—…→");
		} finally {
			c.close();
		}
	}, 60_000);
});

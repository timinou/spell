/**
 * Real-BEAM integration test: spawn the actual PtcRuntime via `mix run` and
 * round-trip through it. This is the end-to-end proof of Phase 0 — spawn.ts +
 * the real Elixir peer + client.ts working together over real stdio.
 *
 * Skipped automatically when the runtime isn't built (no `_build`) or `mix`
 * isn't on PATH, so the suite stays green in environments without Elixir. To
 * force-run locally: ensure `cd beam/ptc_runtime && mix deps.get` has run.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "bun:test";
import { PtcRuntimeClient, spawnTransport } from "./client";
import { PERMISSIVE_POLICY } from "./policy";
import { type DispatchableTool, lookupFromMap, makeToolDispatcher } from "./tool-dispatch";

describe("spawn failure handling", () => {
	it("rejects (not hangs) when the runtime binary does not exist", async () => {
		// A bogus PTC_RUNTIME_BIN emits a child 'error' (ENOENT), which must route
		// into onClose so init() rejects rather than hanging forever.
		const { transport } = spawnTransport({ env: { PTC_RUNTIME_BIN: "/nonexistent/ptc_runtime_xyz" } });
		const client = new PtcRuntimeClient({ transport, onToolCall: async () => null });
		try {
			await expect(client.init({ tools: [] })).rejects.toThrow();
		} finally {
			client.close();
		}
	}, 15_000);
});

const runtimeDir = path.resolve(import.meta.dirname, "..", "..", "..", "..", "..", "beam", "ptc_runtime");
const hasMix = spawnSync("mix", ["--version"], { stdio: "ignore" }).status === 0;
const built = existsSync(path.join(runtimeDir, "_build"));
const runnable = hasMix && built;

const d = runnable ? describe : describe.skip;

d("real BEAM round-trip", () => {
	it("inits, computes, and services a reentrant tool_call", async () => {
		const { transport } = spawnTransport({ runtimeDir });
		const client = new PtcRuntimeClient({
			transport,
			onToolCall: async ({ tool, args }) => {
				if (tool === "sq") return (args as { n: number }).n ** 2;
				throw new Error(`unknown tool ${tool}`);
			},
		});

		try {
			const initRes = await client.init({ tools: [{ name: "sq" }] });
			expect(initRes.tools).toContain("sq");

			// Pure compute.
			await expect(client.execute({ program: "(+ 40 2)" })).resolves.toBe(42);

			// Reentrant tool_call through real stdio.
			await expect(client.execute({ program: "(tool/sq {:n 9})" })).resolves.toBe(81);

			// pmap fan-out: many concurrent tool_calls over the wire.
			await expect(
				client.execute({ program: "(pmap (fn [x] (tool/sq {:n x})) [1 2 3 4])" }),
			).resolves.toEqual([1, 4, 9, 16]);

			// Signature-validated structured return.
			await expect(
				client.execute({
					program: "{:total (count data/xs)}",
					context: { xs: [1, 2, 3] },
					signature: "{total :int}",
				}),
			).resolves.toEqual({ total: 3 });
		} finally {
			client.close();
		}
	}, 60_000);

	it("drives REAL tool dispatch through the bridge end-to-end", async () => {
		// A real Spell-shaped tool, dispatched via makeToolDispatcher, reached from
		// inside a PTC-Lisp program over a real BEAM. This is the full P1 seam.
		const calls: Array<{ tool: string; args: unknown }> = [];
		const tools = new Map<string, DispatchableTool>([
			[
				"org",
				{
					name: "org",
					async execute(_id, params) {
						calls.push({ tool: "org", args: params });
						// Return structured details (the rich path).
						return {
							content: [{ type: "text", text: "3 items" }],
							details: { items: [{ layer: "a" }, { layer: "a" }, { layer: "b" }] },
						};
					},
				},
			],
		]);
		const { transport } = spawnTransport({ runtimeDir });
		const client = new PtcRuntimeClient({
			transport,
			onToolCall: makeToolDispatcher({ lookup: lookupFromMap(tools), policy: PERMISSIVE_POLICY }),
		});
		try {
			await client.init({ tools: [{ name: "org" }] });

			// Program: call org, group its items by layer, count each — the
			// canonical aggregation idiom, computed in-sandbox.
			const program = `(let [r (tool/org {:command "query"})] (-> (group-by :layer (get r "items")) (update-vals count)))`;
			const result = await client.execute({ program });
			expect(result).toEqual({ a: 2, b: 1 });
			expect(calls).toHaveLength(1);
			expect((calls[0].args as { command: string }).command).toBe("query");
		} finally {
			client.close();
		}
	}, 60_000);

	it("surfaces a sandbox error without killing the runtime", async () => {
		const { transport } = spawnTransport({ runtimeDir });
		const client = new PtcRuntimeClient({ transport, onToolCall: async () => null });
		try {
			await client.init({ tools: [] });
			// Loop-limit / timeout → rejects, BEAM survives.
			await expect(
				client.execute({ program: "(loop [i 0] (recur (inc i)))", timeoutMs: 200 }),
			).rejects.toThrow();
			// Still usable afterwards.
			await expect(client.execute({ program: "(* 6 7)" })).resolves.toBe(42);
		} finally {
			client.close();
		}
	}, 60_000);
});

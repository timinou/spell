/**
 * Proves the FORMAT tile's starter program (FUP-121) is REAL, not aspirational:
 * it runs against the live BEAM runtime with mock find/edit tools and verifies the
 * whitespace-hygiene logic + every builtin it relies on (split-lines, trimr, join,
 * trim-newline, some?, str) actually resolve and behave. Skipped when the BEAM
 * runtime isn't built (mirrors shines.integration.test.ts gating).
 *
 * NB: this is the CORE transform expression copied verbatim from the panel's
 * FORMAT_STARTER (the per-file normalize). If you change FORMAT_STARTER, change
 * this fixture in lockstep.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { PtcRuntimeClient, spawnTransport } from "./client";
import { PERMISSIVE_POLICY } from "./policy";
import { type DispatchableTool, lookupFromMap, makeToolDispatcher } from "./tool-dispatch";

const runtimeDir = path.resolve(import.meta.dirname, "..", "..", "..", "..", "..", "beam", "ptc_runtime");
const runnable =
	spawnSync("mix", ["--version"], { stdio: "ignore" }).status === 0 && existsSync(path.join(runtimeDir, "_build"));
const d = runnable ? describe : describe.skip;

function tool(name: string, fn: (args: Record<string, unknown>) => unknown): DispatchableTool {
	return {
		name,
		async execute(_id: unknown, params: unknown) {
			const data = fn(params as Record<string, unknown>);
			return { content: [], details: data, data } as never;
		},
	} as unknown as DispatchableTool;
}

// Two files: one with trailing whitespace + missing final newline (DRIFT), one
// already clean (NO drift). `find` with a glob lists them; `find … #raw` returns
// each file's text; `edit` records what would be written.
const FILES = ["dirty.ts", "clean.ts"];
const RAW: Record<string, string> = {
	"dirty.ts": "const a = 1   \nconst b = 2\t\n", // trailing ws, trailing newline noise
	"clean.ts": "const ok = 1\n",
};
const edited: Array<{ path: string; content: string }> = [];

const TOOLS = new Map<string, DispatchableTool>([
	[
		"find",
		tool("find", (args: Record<string, unknown>) => {
			const target = String(args.target ?? "");
			const rawMatch = target.match(/^(.*)#raw$/);
			if (rawMatch) return { text: RAW[rawMatch[1]] ?? "" };
			return { hits: FILES };
		}),
	],
	[
		"edit",
		tool("edit", (args: Record<string, unknown>) => {
			const ops = (args.operations ?? []) as Array<{ target: string; action: { content: string } }>;
			for (const op of ops) edited.push({ path: op.target, content: op.action.content });
			return { ok: true };
		}),
	],
]);

let client: PtcRuntimeClient;

// The per-file normalize, verbatim from FORMAT_STARTER, wrapped to return the list
// of changed paths so we can assert the drift detection + the written content.
const PROGRAM = `
(->> (get (tool/find {:target "src/**/*.ts"}) "hits")
     (map (fn [path]
            (let [orig (get (tool/find {:target (str path "#raw")}) "text")
                  trimmed (join "\\n" (map trimr (split-lines orig)))
                  fixed (str (trim-newline trimmed) "\\n")]
              (when (not= orig fixed)
                (tool/edit {:operations [{:target path
                                          :action {:kind "replace" :content fixed}}]})
                path))))
     (filter some?))`;

d("FUP-121 format starter program — real BEAM", () => {
	beforeAll(async () => {
		const { transport } = spawnTransport({ runtimeDir });
		client = new PtcRuntimeClient({
			transport,
			onToolCall: makeToolDispatcher({ lookup: lookupFromMap(TOOLS), policy: PERMISSIVE_POLICY }),
		});
		await client.init({ tools: [{ name: "find" }, { name: "edit" }] });
	}, 60_000); // cold `mix` compile on the first BEAM spawn can exceed the 5s default
	afterAll(() => client?.close());

	it("detects drift in exactly the dirty file and writes the normalized content", async () => {
		edited.length = 0;
		const changed = (await client.execute({ program: PROGRAM })) as string[];
		// Only the dirty file drifts; the clean file is left untouched.
		expect(changed).toEqual(["dirty.ts"]);
		expect(edited).toHaveLength(1);
		expect(edited[0]?.path).toBe("dirty.ts");
		// Trailing whitespace stripped per line; exactly one final newline.
		expect(edited[0]?.content).toBe("const a = 1\nconst b = 2\n");
	});
});

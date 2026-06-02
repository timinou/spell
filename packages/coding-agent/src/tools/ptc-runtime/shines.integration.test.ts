/**
 * Golden tests for the "where PtcRunner shines" examples.
 *
 * Each example from specs/beam-orchestrator/04-where-ptcrunner-shines.md is run
 * here against a real BEAM with fake-but-realistic tools, asserting the exact
 * shaped output. These tests are the ORACLE: the doc's programs are copied from
 * here, so the doc can never drift back into invented syntax. (The original doc
 * used `(tool/call {:tool ...})`, `:value` unwrapping, and `map-vals` — none of
 * which exist. These are the corrected, verified forms.)
 *
 * Skipped when the runtime isn't built.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@spell/pi-agent-core";
import { PtcRuntimeClient, spawnTransport } from "./client";
import { PERMISSIVE_POLICY } from "./policy";
import { type DispatchableTool, lookupFromMap, makeToolDispatcher } from "./tool-dispatch";

const runtimeDir = path.resolve(import.meta.dirname, "..", "..", "..", "..", "..", "beam", "ptc_runtime");
const runnable =
	spawnSync("mix", ["--version"], { stdio: "ignore" }).status === 0 && existsSync(path.join(runtimeDir, "_build"));
const d = runnable ? describe : describe.skip;

/** A tool returning fixed structured details. */
function tool(name: string, fn: (args: Record<string, unknown>) => unknown): DispatchableTool {
	return {
		name,
		async execute(_id, params) {
			return { content: [], details: fn(params as Record<string, unknown>) } as AgentToolResult;
		},
	};
}

// Realistic fixtures shared across examples.
const ORG_ITEMS = [
	{ identifier: "K-1", layer: "kernel", priority: 1, "blocked-by": [] },
	{ identifier: "K-2", layer: "kernel", priority: 2, "blocked-by": ["K-1"] },
	{ identifier: "K-3", layer: "kernel", priority: 1, "blocked-by": [] },
	{ identifier: "U-1", layer: "ui", priority: 2, "blocked-by": [] },
	{ identifier: "U-2", layer: "ui", priority: 1, "blocked-by": ["U-1"] },
];

const TODO_HITS = [
	{ file: "src/a.rs", line: 10 },
	{ file: "src/a.rs", line: 20 },
	{ file: "src/b.rs", line: 5 },
];

const GIT_AUTHORS = "alice\nbob\nalice\nalice\nbob\ncarol\n";

const TOOLS = new Map<string, DispatchableTool>([
	["org", tool("org", () => ({ items: ORG_ITEMS }))],
	["find", tool("find", () => ({ hits: TODO_HITS }))],
	["bash", tool("bash", () => ({ stdout: GIT_AUTHORS, exit: 0 }))],
	[
		"memory",
		tool("memory", () => ({
			hits: [
				{ id: "C1", title: "lock liveness", score: 0.9 },
				{ id: "C2", title: "lock liveness", score: 0.7 }, // dup title
				{ id: "C3", title: "warm kernel", score: 0.8 },
			],
		})),
	],
	["files", tool("files", () => ({ files: ["a.test.ts", "b.ts", "c.test.ts"] }))],
	["du", tool("du", () => ({ rows: [{ bytes: 100 }, { bytes: 250 }, { bytes: 50 }] }))],
	[
		"ci",
		tool("ci", () => ({
			runs: [
				{ id: "K-1", pass: true },
				{ id: "K-2", pass: false },
			],
		})),
	],
]);

let client: PtcRuntimeClient;

d("where PtcRunner shines — golden examples", () => {
	beforeAll(async () => {
		const { transport } = spawnTransport({ runtimeDir });
		client = new PtcRuntimeClient({
			transport,
			// bash is exec (denied by default); these golden tests use permissive
			// to demonstrate the full mixing model (the doc notes the policy).
			onToolCall: makeToolDispatcher({ lookup: lookupFromMap(TOOLS), policy: PERMISSIVE_POLICY }),
		});
		await client.init({
			tools: [
				{ name: "org" },
				{ name: "find" },
				{ name: "bash" },
				{ name: "memory" },
				{ name: "files" },
				{ name: "du" },
				{ name: "ci" },
			],
		});
	});

	afterAll(() => client?.close());

	const run = (program: string, signature?: string) => client.execute({ program, signature });

	it("1. count + group by file", async () => {
		const program = `
      (let [hits (get (tool/find {:target "src/**/*.rs"}) "hits")]
        {:total (count hits)
         :by-file (update-vals (group-by (fn [h] (get h "file")) hits) count)})`;
		expect(await run(program)).toEqual({ total: 3, "by-file": { "src/a.rs": 2, "src/b.rs": 1 } });
	});

	it("3. git log post-processing — bash for I/O, Lisp for the reduce", async () => {
		const program = `
      (->> (get (tool/bash {:command "git log --pretty=%an"}) "stdout")
           (#(split % "\\n"))
           (filter (fn [s] (not (empty? s))))
           frequencies)`;
		expect(await run(program)).toEqual({ alice: 3, bob: 2, carol: 1 });
	});

	it("6. org dashboard rollup", async () => {
		const program = `
      (update-vals
        (group-by (fn [it] (get it "layer"))
                  (get (tool/org {:command "query" :query "todo:DOING"}) "items"))
        (fn [g]
          {:open (count g)
           :hi-pri (count (filter (fn [it] (= 1 (get it "priority"))) g))
           :blocked (count (filter (fn [it] (seq (get it "blocked-by"))) g))}))`;
		expect(await run(program)).toEqual({
			kernel: { open: 3, "hi-pri": 2, blocked: 1 },
			ui: { open: 2, "hi-pri": 1, blocked: 1 },
		});
	});

	it("7. memory rerank + dedup by title (group-by/vals/first — no dedupe-by builtin)", async () => {
		const program = `
      (->> (get (tool/memory {:action "search" :text "lock liveness"}) "hits")
           (sort-by (fn [h] (get h "score")) >)
           (group-by (fn [h] (get h "title")))
           vals
           (map first)
           (sort-by (fn [h] (get h "score")) >)
           (take 5)
           (map (fn [h] (select-keys h ["id" "title"]))))`;
		expect(await run(program)).toEqual([
			{ id: "C1", title: "lock liveness" },
			{ id: "C3", title: "warm kernel" },
		]);
	});

	it("9. find graph edges → impact by package (frequencies projection)", async () => {
		// Group def→ call-site files by package (2nd path segment).
		const program = `
      (->> (get (tool/find {:target "x::verify def→"}) "hits")
           (map (fn [h] (get h "file")))
           (map (fn [f] (nth (split f "/") 1)))
           frequencies)`;
		// find returns files src/a.rs, src/a.rs, src/b.rs → 2nd segment a.rs/b.rs.
		expect(await run(program)).toEqual({ "a.rs": 2, "b.rs": 1 });
	});

	it("2. fan-out filter — files matching a pattern, capped", async () => {
		const program = `
      (->> (get (tool/files {}) "files")
           (filter (fn [x] (re-find #"test" x)))
           (take 20))`;
		expect(await run(program)).toEqual(["a.test.ts", "c.test.ts"]);
	});

	it("4. numeric aggregate — sum bytes", async () => {
		const program = `(reduce + 0 (map (fn [r] (get r "bytes")) (get (tool/du {}) "rows")))`;
		expect(await run(program)).toBe(400);
	});

	it("5. declarative replacement for a bash for-loop — per-package counts, sorted", async () => {
		// 'for each package, count its items, sort desc' — declarative, not a loop.
		const program = `
      (->> (get (tool/org {:command "query"}) "items")
           (group-by (fn [it] (get it "layer")))
           (#(map (fn [[k g]] [k (count g)]) %))
           (sort-by second >))`;
		expect(await run(program)).toEqual([
			["kernel", 3],
			["ui", 2],
		]);
	});

	it("8. cross-source JOIN — org items × CI status, keep failures", async () => {
		const program = `
      (let [runs (get (tool/ci {}) "runs")
            pass-by-id (update-vals (group-by (fn [r] (get r "id")) runs)
                                    (fn [g] (get (first g) "pass")))]
        (->> (get (tool/org {:command "query"}) "items")
             (filter (fn [it] (contains? pass-by-id (get it "identifier"))))
             (map (fn [it] {:id (get it "identifier")
                            :pass (get pass-by-id (get it "identifier"))}))
             (filter (fn [r] (not (get r "pass"))))))`;
		expect(await run(program)).toEqual([{ id: "K-2", pass: false }]);
	});

	it("10. signature-validated extraction", async () => {
		const program = `{:total (count (get (tool/org {:command "query"}) "items"))}`;
		expect(await run(program, "{total :int}")).toEqual({ total: 5 });
	});
});

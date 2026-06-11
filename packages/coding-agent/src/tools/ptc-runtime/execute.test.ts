/**
 * Execute tool tests. Unit tests use an injected ToolProvider so the tool spawns
 * a REAL BEAM (skipped when not built) but with a controlled tool surface, and
 * assert the AgentTool contract: result shape, error path, policy filtering,
 * dispose lifecycle.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentToolResult } from "@spell/pi-agent-core";
import { ExecuteTool, resolveMaxHeapWords } from "./execute";
import { DEFAULT_POLICY, PERMISSIVE_POLICY } from "./policy";
import type { DispatchableTool, ToolProvider } from "./tool-dispatch";

const runtimeDir = path.resolve(import.meta.dirname, "..", "..", "..", "..", "..", "beam", "ptc_runtime");
const runnable =
	spawnSync("mix", ["--version"], { stdio: "ignore" }).status === 0 && existsSync(path.join(runtimeDir, "_build"));
const d = runnable ? describe : describe.skip;

/** A provider exposing a couple of fake tools with chosen names. */
function provider(tools: DispatchableTool[]): ToolProvider {
	const map = new Map(tools.map(t => [t.name, t]));
	return {
		catalogTools: () => tools.map(t => ({ name: t.name, parameters: Type.Object({}) })),
		lookup: name => map.get(name),
	};
}

function dataTool(name: string, details: unknown): DispatchableTool {
	return {
		name,
		async execute() {
			return { content: [], details, data: details } as AgentToolResult;
		},
	};
}

d("ExecuteTool (real BEAM, injected provider)", () => {
	it("runs a pure program and returns a text result", async () => {
		const tool = new ExecuteTool(undefined, { policy: PERMISSIVE_POLICY, provider: provider([]) });
		try {
			const r = await tool.execute("c1", { program: "(+ 2 3)" });
			expect(r.isError).toBeFalsy();
			expect(r.content[0]).toMatchObject({ type: "text", text: "5" });
			expect(r.details?.program).toBe("(+ 2 3)");
		} finally {
			await tool.dispose();
		}
	}, 60_000);

	it("flows a tool-call result into the program (write tool allowed by default)", async () => {
		// 'org' is write-tagged → allowed under DEFAULT_POLICY.
		const tool = new ExecuteTool(undefined, {
			policy: DEFAULT_POLICY,
			provider: provider([dataTool("org", { items: [1, 2, 3] })]),
		});
		try {
			const r = await tool.execute("c2", {
				program: '(reduce + 0 (get (tool/org {:command "query"}) "items"))',
			});
			expect(r.isError).toBeFalsy();
			expect(r.content[0]).toMatchObject({ text: "6" });
		} finally {
			await tool.dispose();
		}
	}, 60_000);

	it("returns isError for a sandbox failure, runtime survives", async () => {
		const tool = new ExecuteTool(undefined, { policy: PERMISSIVE_POLICY, provider: provider([]) });
		try {
			const bad = await tool.execute("c3", { program: "(loop [i 0] (recur (inc i)))", timeout_ms: 200 });
			expect(bad.isError).toBe(true);
			// Same instance still works.
			const ok = await tool.execute("c4", { program: "(* 6 7)" });
			expect(ok.content[0]).toMatchObject({ text: "42" });
		} finally {
			await tool.dispose();
		}
	}, 60_000);

	it("denies an exec tool under the default policy (program sees a tool error)", async () => {
		// 'bash' is exec-tagged → denied under DEFAULT_POLICY. It is also filtered
		// out of the advertised catalog, so the program can't even resolve it.
		const tool = new ExecuteTool(undefined, {
			policy: DEFAULT_POLICY,
			provider: provider([dataTool("bash", { stdout: "should not run" })]),
		});
		try {
			const r = await tool.execute("c5", { program: '(tool/bash {:command "ls"})' });
			expect(r.isError).toBe(true);
		} finally {
			await tool.dispose();
		}
	}, 60_000);

	it("caps an over-large result to bound context flood (Review Gate 3, P3)", async () => {
		const tool = new ExecuteTool(undefined, { policy: PERMISSIVE_POLICY, provider: provider([]) });
		try {
			// Build a large string in-sandbox (well over the 16KB cap).
			const r = await tool.execute("c7", { program: '(join "" (map (fn [_] "x") (range 40000)))' });
			const text = (r.content[0] as { text: string }).text;
			expect(text.length).toBeLessThan(20_000);
			expect(text).toContain("[truncated:");
		} finally {
			await tool.dispose();
		}
	}, 60_000);

	it("hands a large result to an artifact and returns its URI + preview (PLAN-325)", async () => {
		let saved: { content: string; toolType: string } | undefined;
		const saveArtifact = async (content: string | Uint8Array, toolType: string) => {
			saved = { content: typeof content === "string" ? content : Buffer.from(content).toString(), toolType };
			return { id: "7", uri: "artifact://sess/main/execute/7.json", path: "/tmp/7.json" };
		};
		const tool = new ExecuteTool(undefined, {
			policy: PERMISSIVE_POLICY,
			provider: provider([]),
			saveArtifact,
		});
		try {
			const r = await tool.execute("c8", { program: '(join "" (map (fn [_] "x") (range 40000)))' });
			const text = (r.content[0] as { text: string }).text;
			// The full value went to the artifact …
			expect(saved).toBeDefined();
			expect(saved?.content.length).toBeGreaterThanOrEqual(40_000);
			expect(saved?.toolType).toBe("execute");
			// … and the model sees the URI + a bounded preview, not the whole blob.
			expect(text).toContain("artifact://sess/main/execute/7.json");
			expect(text.length).toBeLessThan(20_000);
			// details carries the artifact ref for programmatic consumers.
			expect((r.details as { artifactUri?: string }).artifactUri).toBe("artifact://sess/main/execute/7.json");
		} finally {
			await tool.dispose();
		}
	}, 60_000);

	it("falls back to truncation when no artifact sink is available (PLAN-325)", async () => {
		const tool = new ExecuteTool(undefined, { policy: PERMISSIVE_POLICY, provider: provider([]) });
		try {
			const r = await tool.execute("c9", { program: '(join "" (map (fn [_] "x") (range 40000)))' });
			const text = (r.content[0] as { text: string }).text;
			expect(text).toContain("[truncated:");
			expect(text).not.toContain("artifact://");
		} finally {
			await tool.dispose();
		}
	}, 60_000);

	it("lazily re-inits a fresh runtime after dispose (PLAN-324 respawn lifecycle)", async () => {
		const tool = new ExecuteTool(undefined, { policy: PERMISSIVE_POLICY, provider: provider([]) });
		try {
			const a = await tool.execute("r1", { program: "(+ 1 1)" });
			expect(a.content[0]).toMatchObject({ text: "2" });
			// Tear the runtime down, then execute again: the tool must transparently
			// spawn a fresh runtime rather than fail on the disposed client. (The
			// closed-client respawn predicate itself is unit-covered by client.closed.)
			await tool.dispose();
			const b = await tool.execute("r2", { program: "(* 7 6)" });
			expect(b.isError).toBeFalsy();
			expect(b.content[0]).toMatchObject({ text: "42" });
		} finally {
			await tool.dispose();
		}
	}, 60_000);

	it("signature-validates the return", async () => {
		const tool = new ExecuteTool(undefined, { policy: PERMISSIVE_POLICY, provider: provider([]) });
		try {
			const r = await tool.execute("c6", {
				program: "{:n (count data/xs)}",
				context: { xs: [1, 2, 3, 4] },
				signature: "{n :int}",
			});
			expect(r.content[0]).toMatchObject({ text: '{\n  "n": 4\n}' });
		} finally {
			await tool.dispose();
		}
	}, 60_000);
});

// Pure resolver — no BEAM needed (FEAT-791).
describe("resolveMaxHeapWords", () => {
	const MB = (n: number) => Math.floor((n * 1024 * 1024) / 8);

	it("returns undefined when neither setting nor request deviates (runtime default applies)", () => {
		expect(resolveMaxHeapWords(0)).toBeUndefined();
	});

	it("setting raises the ceiling for every program", () => {
		expect(resolveMaxHeapWords(64)).toBe(MB(64));
	});

	it("per-call request clamps to the operator setting", () => {
		expect(resolveMaxHeapWords(64, 128)).toBe(MB(64));
		expect(resolveMaxHeapWords(64, 16)).toBe(MB(16));
	});

	it("without a setting, a request can only tighten below the runtime default", () => {
		expect(resolveMaxHeapWords(0, 200)).toBe(MB(50));
		expect(resolveMaxHeapWords(0, 8)).toBe(MB(8));
	});

	it("hard-caps at 256MB regardless of setting size (typo guard)", () => {
		expect(resolveMaxHeapWords(10_000)).toBe(MB(256));
		expect(resolveMaxHeapWords(10_000, 9_999)).toBe(MB(256));
	});

	it("floors a sub-1MB request to 1MB", () => {
		expect(resolveMaxHeapWords(64, 0)).toBe(MB(1));
	});
});

/**
 * Stored programs (W4 / FEAT-810) tests.
 *
 * Two layers:
 *  - Pure unit tests for the read-only guard + store-time validation (no BEAM).
 *  - Integration tests (real BEAM, injected provider) for round-trip identity
 *    and the preflight + run paths, gated on a built ptc_runtime like the
 *    execute.test.ts suite.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentToolResult } from "@spell/pi-agent-core";
import { describe, expect, it } from "bun:test";
import { ExecuteTool } from "./execute";
import { DEFAULT_POLICY, PERMISSIVE_POLICY } from "./policy";
import {
	assertReadOnly,
	extractToolCalls,
	StoredProgramWriteError,
	validateStoredProgram,
} from "./stored-program";
import type { DispatchableTool, ToolProvider } from "./tool-dispatch";

// ----------------------------------------------------------------------------
// Pure unit tests — read-only guard (no BEAM needed)
// ----------------------------------------------------------------------------

describe("extractToolCalls", () => {
	it("extracts tool names and literal sub-commands", () => {
		const calls = extractToolCalls(
			`(let [d (tool/org {:command "dashboard"})] (tool/find {:target "x"}))`,
		);
		expect(calls.map(c => c.name)).toEqual(["org", "find"]);
		expect(calls[0].command).toBe("dashboard");
		expect(calls[0].computedSubcommand).toBe(false);
	});

	it("flags a computed (non-literal) sub-command", () => {
		const calls = extractToolCalls(`(tool/org {:command cmd})`);
		expect(calls[0].command).toBeUndefined();
		expect(calls[0].computedSubcommand).toBe(true);
	});

	it("extracts a literal :action for the memory tool", () => {
		const calls = extractToolCalls(`(tool/memory {:action "search" :text "x"})`);
		expect(calls[0].action).toBe("search");
	});
});

describe("assertReadOnly", () => {
	it("admits a pure program (no tool calls)", () => {
		expect(() => assertReadOnly(`(+ 1 2)`)).not.toThrow();
	});

	it("admits a read tool (find)", () => {
		expect(() => assertReadOnly(`(tool/find {:target "src/**/*.rs"})`)).not.toThrow();
	});

	it("admits org dashboard — the canonical W4 tile (write tool, read sub-command)", () => {
		// `org` is statically tagged `write`, but `:command "dashboard"` refines
		// it to `read`. This is the whole point of arg-aware effect resolution.
		expect(() => assertReadOnly(`(tool/org {:command "dashboard"})`)).not.toThrow();
		expect(() => assertReadOnly(`(tool/org {:command "query"})`)).not.toThrow();
	});

	it("admits memory search (read action)", () => {
		expect(() => assertReadOnly(`(tool/memory {:action "search" :text "x"})`)).not.toThrow();
	});

	it("rejects a write tool (edit)", () => {
		expect(() => assertReadOnly(`(tool/edit {:target "f"})`)).toThrow(StoredProgramWriteError);
	});

	it("rejects create", () => {
		expect(() => assertReadOnly(`(tool/create {:path "f"})`)).toThrow(StoredProgramWriteError);
	});

	it("rejects org with a write sub-command", () => {
		expect(() => assertReadOnly(`(tool/org {:command "set" :id "X"})`)).toThrow(
			StoredProgramWriteError,
		);
	});

	it("rejects memory save (write action)", () => {
		expect(() => assertReadOnly(`(tool/memory {:action "save" :title "x"})`)).toThrow(
			StoredProgramWriteError,
		);
	});

	it("rejects org with a COMPUTED sub-command — cannot prove read-only", () => {
		// A non-literal :command could be "set" at runtime; we cannot prove read.
		const err = (() => {
			try {
				assertReadOnly(`(tool/org {:command cmd})`);
			} catch (e) {
				return e as StoredProgramWriteError;
			}
		})();
		expect(err).toBeInstanceOf(StoredProgramWriteError);
		expect(err?.message).toContain("computed");
	});

	it("rejects a read program that ALSO writes (mixed)", () => {
		expect(() =>
			assertReadOnly(`(let [d (tool/org {:command "query"})] (tool/edit {:target "f"}))`),
		).toThrow(StoredProgramWriteError);
	});
});

describe("validateStoredProgram (read-only guard + injected preflight)", () => {
	const okValidator = async () => ({ ok: true });
	const failValidator = async () => ({ ok: false, errors: ["Undefined variable: map-vals"] });

	it("passes a read-only, parseable program", async () => {
		const r = await validateStoredProgram({ program: `(tool/find {:target "x"})` }, okValidator);
		expect(r.ok).toBe(true);
	});

	it("rejects a write program at the read-only guard (before preflight)", async () => {
		// The validator would pass, but read-only fails first — and the preflight
		// must NOT even be consulted for a write program.
		let preflightCalled = false;
		const spyValidator = async () => {
			preflightCalled = true;
			return { ok: true };
		};
		const r = await validateStoredProgram({ program: `(tool/edit {:target "f"})` }, spyValidator);
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.reason).toBe("not-read-only");
		expect(preflightCalled).toBe(false);
	});

	it("rejects a typo'd program at preflight (read-only but unparseable-symbol)", async () => {
		const r = await validateStoredProgram({ program: `(map-vals inc {"a" 1})` }, failValidator);
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.reason).toBe("preflight");
		expect(r.ok === false && r.reason === "preflight" && r.errors[0]).toContain("map-vals");
	});
});

// ----------------------------------------------------------------------------
// Integration tests — real BEAM, injected provider (gated like execute.test.ts)
// ----------------------------------------------------------------------------

const runtimeDir = path.join(import.meta.dir, "../../../../../beam/ptc_runtime");
const runnable =
	spawnSync("mix", ["--version"], { stdio: "ignore" }).status === 0 &&
	existsSync(path.join(runtimeDir, "_build"));
const d = runnable ? describe : describe.skip;

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

d("stored programs (real BEAM)", () => {
	it("round-trip: a stored read-only program reproduces its inline value", async () => {
		const tool = new ExecuteTool(undefined, {
			policy: DEFAULT_POLICY,
			provider: provider([dataTool("org", { items: [1, 2, 3] })]),
		});
		try {
			const program = `(count (get (tool/org {:command "query"}) "items"))`;
			// Inline run.
			const inline = await tool.execute("c1", { program });
			// Stored run via the shared path.
			const stored = await tool.runStored({ program });
			expect(stored.data).toBe(inline.data);
			expect(stored.data).toBe(3);
		} finally {
			await tool.dispose();
		}
	}, 30_000);

	it("validateProgram passes a good program and fails a typo (0 effects)", async () => {
		const tool = new ExecuteTool(undefined, { policy: PERMISSIVE_POLICY, provider: provider([]) });
		try {
			expect((await tool.validateProgram(`(+ 1 2)`)).ok).toBe(true);
			const bad = await tool.validateProgram(`(map-vals inc {"a" 1})`);
			expect(bad.ok).toBe(false);
			expect(bad.errors?.[0]).toContain("map-vals");
		} finally {
			await tool.dispose();
		}
	}, 30_000);

	it("end-to-end: validateStoredProgram + runStored over the real runtime", async () => {
		const tool = new ExecuteTool(undefined, {
			policy: DEFAULT_POLICY,
			provider: provider([dataTool("org", { items: [{ id: "A" }, { id: "B" }] })]),
		});
		try {
			const stored = {
				program: `(count (get (tool/org {:command "dashboard"}) "items"))`,
				title: "count dashboard items",
			};
			const v = await validateStoredProgram(stored, p => tool.validateProgram(p));
			expect(v.ok).toBe(true);
			const res = await tool.runStored(stored);
			expect(res.data).toBe(2);
		} finally {
			await tool.dispose();
		}
	}, 30_000);

	it("a stored signature is re-validated on run", async () => {
		const tool = new ExecuteTool(undefined, {
			policy: DEFAULT_POLICY,
			provider: provider([dataTool("org", { items: [1, 2] })]),
		});
		try {
			const res = await tool.runStored({
				program: `(count (get (tool/org {:command "query"}) "items"))`,
				signature: "{count :int}".replace("{count :int}", ":int"),
			});
			expect(res.data).toBe(2);
		} finally {
			await tool.dispose();
		}
	}, 30_000);
});

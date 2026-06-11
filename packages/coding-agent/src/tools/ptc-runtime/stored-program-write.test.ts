/**
 * W4-write (FUP-112) tests — stored programs that MUTATE, transactionally.
 *
 * Two layers:
 *  - Pure unit tests for the write-mode store-time bar (mode branching in
 *    validateStoredProgram) — no BEAM.
 *  - Integration tests (real BEAM, injected FS-write tools, temp dir) for the
 *    three-valued RunIntent: interactive (writes for real), visible-refresh
 *    (dry-run preview, no mutation), background-tick (inert unless armed).
 */

import { spawnSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentToolResult } from "@spell/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ExecuteTool, type StoredProgramInput } from "./execute";
import { PERMISSIVE_POLICY } from "./policy";
import { validateStoredProgram } from "./stored-program";
import type { DispatchableTool, ToolProvider } from "./tool-dispatch";

// ----------------------------------------------------------------------------
// Unit — the write-mode store-time bar (mode branching)
// ----------------------------------------------------------------------------

describe("validateStoredProgram (write mode bar)", () => {
	const okValidator = async () => ({ ok: true });

	it("accepts a write-mode program that only writes FILES", async () => {
		const r = await validateStoredProgram(
			{ program: `(tool/edit {:operations [{:target "a.ts"}]}) (tool/create {:path "b"})`, mode: "write" },
			okValidator,
		);
		expect(r.ok).toBe(true);
	});

	it("accepts a write-mode program mixing FILE writes with READS", async () => {
		const r = await validateStoredProgram(
			{ program: `(let [d (tool/org {:command "query"})] (tool/edit {:operations [{:target "a.ts"}]}))`, mode: "write" },
			okValidator,
		);
		expect(r.ok).toBe(true);
	});

	it("REJECTS a write-mode program mixing FILE writes with a non-rollback-able mutation", async () => {
		const r = await validateStoredProgram(
			{ program: `(tool/edit {:operations [{:target "a.ts"}]}) (tool/org {:command "set" :id "X"})`, mode: "write" },
			okValidator,
		);
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.reason).toBe("not-rollback-safe");
		expect(r.ok === false && r.reason === "not-rollback-safe" && r.fsTool).toBe("edit");
		expect(r.ok === false && r.reason === "not-rollback-safe" && r.unsafeTool).toBe("org");
	});

	it("REJECTS a write-mode program mixing file writes with side-effecting bash", async () => {
		const r = await validateStoredProgram(
			{ program: `(tool/create {:path "a"}) (tool/bash {:command "rm x"})`, mode: "write" },
			okValidator,
		);
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.reason).toBe("not-rollback-safe");
	});

	it("a WRITE program is rejected under the default (read) mode — mode must be explicit", async () => {
		// Same program, no mode → defaults to read → the read-only bar rejects it.
		const r = await validateStoredProgram(
			{ program: `(tool/edit {:operations [{:target "a.ts"}]})` },
			okValidator,
		);
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.reason).toBe("not-read-only");
	});

	it("a write-mode program still gets the preflight (typo) check", async () => {
		const failValidator = async () => ({ ok: false, errors: ["Undefined variable: map-vals"] });
		const r = await validateStoredProgram(
			{ program: `(tool/edit {:operations [{:target "a.ts"}]}) (map-vals inc {})`, mode: "write" },
			failValidator,
		);
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.reason).toBe("preflight");
	});
});

// ----------------------------------------------------------------------------
// Integration — real BEAM: the three-valued RunIntent
// ----------------------------------------------------------------------------

const runtimeDir = path.resolve(import.meta.dirname, "..", "..", "..", "..", "..", "beam", "ptc_runtime");
const runnable =
	spawnSync("mix", ["--version"], { stdio: "ignore" }).status === 0 &&
	existsSync(path.join(runtimeDir, "_build"));
const d = runnable ? describe : describe.skip;

/** A `create`/`edit` pair that actually writes to disk under `dir`. */
function fsWriteTools(dir: string): DispatchableTool[] {
	const create: DispatchableTool = {
		name: "create",
		async execute(_id, args) {
			const p = path.join(dir, (args as { path: string }).path);
			await fs.mkdir(path.dirname(p), { recursive: true });
			await fs.writeFile(p, (args as { content?: string }).content ?? "created");
			return { content: [], data: { path: p, ok: true } } as AgentToolResult;
		},
	};
	const edit: DispatchableTool = {
		name: "edit",
		async execute(_id, args) {
			const ops = (args as { operations: Array<{ target: string; content?: string }> }).operations;
			for (const op of ops) await fs.writeFile(path.join(dir, op.target), op.content ?? "edited");
			return { content: [], data: { ok: true } } as AgentToolResult;
		},
	};
	return [create, edit];
}

function provider(tools: DispatchableTool[]): ToolProvider {
	const map = new Map(tools.map(t => [t.name, t]));
	return {
		catalogTools: () => tools.map(t => ({ name: t.name, parameters: Type.Object({}) })),
		lookup: name => map.get(name),
	};
}

d("W4-write three-valued RunIntent (real BEAM)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(tmpdir(), "w4w-"));
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	const writeProgram = (): StoredProgramInput => ({
		program: `(tool/create {:path "out.txt" :content "NEW"}) "done"`,
		mode: "write",
		title: "make out.txt",
	});

	it("interactive: a write program WRITES for real and reports committed", async () => {
		const tool = new ExecuteTool({ cwd: dir } as never, {
			policy: PERMISSIVE_POLICY,
			provider: provider(fsWriteTools(dir)),
		});
		try {
			const res = await tool.runStored(writeProgram(), { intent: "interactive" });
			expect(res.isError).toBeFalsy();
			expect(res.data).toBe("done");
			expect(res.details.transaction).toEqual({ outcome: "committed", files: 1, paths: [path.join(dir, "out.txt")] });
			// The file is really there.
			expect(await fs.readFile(path.join(dir, "out.txt"), "utf-8")).toBe("NEW");
		} finally {
			await tool.dispose();
		}
	}, 30_000);

	it("visible-refresh: a write program is a DRY RUN — preview, no mutation", async () => {
		const tool = new ExecuteTool({ cwd: dir } as never, {
			policy: PERMISSIVE_POLICY,
			provider: provider(fsWriteTools(dir)),
		});
		try {
			const res = await tool.runStored(writeProgram(), { intent: "visible-refresh" });
			expect(res.isError).toBeFalsy();
			// The outcome is a dry-run preview naming the file(s) that WOULD change…
			expect(res.details.transaction?.outcome).toBe("dry-run");
			expect(res.details.transaction?.files).toBe(1);
			expect(res.details.transaction?.paths).toEqual([path.join(dir, "out.txt")]);
			// …but the repo is UNTOUCHED.
			expect(existsSync(path.join(dir, "out.txt"))).toBe(false);
			// The text surfaces the preview.
			expect(res.content[0]?.type === "text" && res.content[0].text).toContain("would change 1 file");
		} finally {
			await tool.dispose();
		}
	}, 30_000);

	it("background-tick, autoWrite OFF: INERT — no run, no mutation", async () => {
		let createCalls = 0;
		const create: DispatchableTool = {
			name: "create",
			async execute() {
				createCalls++;
				return { content: [], data: { ok: true } } as AgentToolResult;
			},
		};
		const tool = new ExecuteTool({ cwd: dir } as never, {
			policy: PERMISSIVE_POLICY,
			provider: provider([create]),
		});
		try {
			const res = await tool.runStored(writeProgram(), { intent: "background-tick" });
			// Inert: the program never ran, the tool was never called, nothing written.
			expect(createCalls).toBe(0);
			expect(res.details.transaction).toEqual({ outcome: "inert", files: 0 });
			expect(existsSync(path.join(dir, "out.txt"))).toBe(false);
		} finally {
			await tool.dispose();
		}
	}, 30_000);

	it("background-tick, autoWrite ON: WRITES for real and reports committed", async () => {
		const tool = new ExecuteTool({ cwd: dir } as never, {
			policy: PERMISSIVE_POLICY,
			provider: provider(fsWriteTools(dir)),
		});
		try {
			const res = await tool.runStored(writeProgram(), { intent: "background-tick", autoWrite: true });
			expect(res.details.transaction?.outcome).toBe("committed");
			expect(await fs.readFile(path.join(dir, "out.txt"), "utf-8")).toBe("NEW");
		} finally {
			await tool.dispose();
		}
	}, 30_000);

	it("a write program that ERRORS mid-run rolls back — repo unchanged, outcome surfaced", async () => {
		const tool = new ExecuteTool({ cwd: dir } as never, {
			policy: PERMISSIVE_POLICY,
			provider: provider(fsWriteTools(dir)),
		});
		try {
			// create out.txt, then fail → D3 rolls the create back.
			const res = await tool.runStored(
				{ program: `(tool/create {:path "out.txt" :content "NEW"}) (fail "boom")`, mode: "write", title: "x" },
				{ intent: "interactive" },
			);
			expect(res.isError).toBe(true);
			expect(res.details.transaction?.outcome).toBe("rolled-back");
			expect(existsSync(path.join(dir, "out.txt"))).toBe(false);
		} finally {
			await tool.dispose();
		}
	}, 30_000);

	it("[P1/P2 fix] a write program with OMITTED mode never commits — readOnly backstop discards", async () => {
		// The silent-mutation hazard: a write program whose `mode` is omitted (or lost
		// across persist/replay) must NOT commit. It defaults to read → the runtime
		// readOnly backstop runs it but DISCARDS any write, in EVERY intent.
		const tool = new ExecuteTool({ cwd: dir } as never, {
			policy: PERMISSIVE_POLICY,
			provider: provider(fsWriteTools(dir)),
		});
		try {
			// NOTE: mode OMITTED — this is the dangerous case.
			const sneaky: StoredProgramInput = { program: `(tool/create {:path "out.txt" :content "NEW"}) "done"` };
			for (const intent of ["interactive", "visible-refresh", "background-tick"] as const) {
				const res = await tool.runStored(sneaky, { intent });
				// The write was DISCARDED, not committed — repo untouched in every intent.
				expect(existsSync(path.join(dir, "out.txt"))).toBe(false);
				// And it is REPORTED as a read-only violation (dry-run outcome + loud note).
				expect(res.details.transaction?.outcome).toBe("dry-run");
				expect(res.content[0]?.type === "text" && res.content[0].text).toContain("read-only");
			}
		} finally {
			await tool.dispose();
		}
	}, 30_000);

	it("[substrate] the execute TOOL surface routes to runStored when mode/intent set", async () => {
		// A host that can only invoke TOOLS (Team Chat tile, canvas armed button)
		// reaches the intent gating by passing mode/intent through the schema.
		const tool = new ExecuteTool({ cwd: dir } as never, {
			policy: PERMISSIVE_POLICY,
			provider: provider(fsWriteTools(dir)),
		});
		try {
			// visible-refresh via the TOOL params → dry-run preview, no mutation.
			const preview = await tool.execute("t1", {
				program: `(tool/create {:path "out.txt" :content "NEW"}) "done"`,
				mode: "write",
				intent: "visible-refresh",
			});
			expect(preview.details.transaction?.outcome).toBe("dry-run");
			expect(existsSync(path.join(dir, "out.txt"))).toBe(false);

			// interactive via the TOOL params → commits for real.
			const applied = await tool.execute("t2", {
				program: `(tool/create {:path "out.txt" :content "NEW"}) "done"`,
				mode: "write",
				intent: "interactive",
			});
			expect(applied.details.transaction?.outcome).toBe("committed");
			expect(await fs.readFile(path.join(dir, "out.txt"), "utf-8")).toBe("NEW");

			// no mode/intent → plain interactive run (unchanged path). It still goes
			// through D3 (every program gets a transaction scope) but makes no writes,
			// so the outcome is "none" — NOT the read-only/dry-run gating of runStored.
			const plain = await tool.execute("t3", { program: `(+ 1 2)` });
			expect(plain.data).toBe(3);
			expect(plain.details.transaction?.outcome).toBe("none");
		} finally {
			await tool.dispose();
		}
	}, 30_000);

	it("a READ program runs identically across all intents (no write to gate)", async () => {
		const tool = new ExecuteTool({ cwd: dir } as never, {
			policy: PERMISSIVE_POLICY,
			provider: provider([
				{
					name: "org",
					async execute() {
						return { content: [], data: { items: [1, 2, 3] }, details: { items: [1, 2, 3] } } as AgentToolResult;
					},
				},
			]),
		});
		const read: StoredProgramInput = {
			program: `(count (get (tool/org {:command "query"}) "items"))`,
			mode: "read",
			title: "count",
		};
		try {
			for (const intent of ["interactive", "visible-refresh", "background-tick"] as const) {
				const res = await tool.runStored(read, { intent });
				expect(res.data).toBe(3);
			}
		} finally {
			await tool.dispose();
		}
	}, 30_000);
});

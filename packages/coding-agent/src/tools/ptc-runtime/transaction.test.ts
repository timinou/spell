/**
 * Transactional write lane (D3 / PLAN-333) tests.
 *
 * Two layers:
 *  - Pure unit tests for TransactionScope (snapshot/commit/rollback + path
 *    extraction), using a real temp dir (no BEAM).
 *  - Integration tests (real BEAM, injected write tools) proving the decisive
 *    E4 property: a create-edit-boom program leaves the repo clean.
 */

import { spawnSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentToolResult } from "@spell/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ExecuteTool } from "./execute";
import { PERMISSIVE_POLICY } from "./policy";
import type { DispatchableTool, ToolProvider } from "./tool-dispatch";
import { effectOf } from "./effects";
import { extractToolCalls } from "./stored-program";
import {
	assertTransactionSafe,
	MixedEffectError,
	TransactionJournal,
	TransactionScope,
	touchedFiles,
} from "./transaction";

// ----------------------------------------------------------------------------
// touchedFiles — path extraction
// ----------------------------------------------------------------------------

describe("touchedFiles", () => {
	// Use a REAL temp dir as cwd so resolveCwdRelativePath's on-disk
	// duplication-guard behaves as it does in production (a non-existent fake cwd
	// makes the resolver drop path segments). We assert the suffix-stripping +
	// per-tool extraction, with the resolved absolute path as the oracle.
	let cwd: string;
	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(tmpdir(), "d3-tf-"));
	});
	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
	});

	it("extracts edit operation targets", () => {
		const files = touchedFiles("edit", { operations: [{ target: "a.ts" }, { target: "b.ts" }] }, cwd);
		expect(files).toEqual([path.join(cwd, "a.ts"), path.join(cwd, "b.ts")]);
	});

	it("strips ::Symbol / #qual / :A-B suffixes to the real file", () => {
		const f = path.join(cwd, "a.ts");
		expect(touchedFiles("edit", { operations: [{ target: "a.ts::Foo.bar" }] }, cwd)).toEqual([f]);
		expect(touchedFiles("edit", { operations: [{ target: "a.ts#body" }] }, cwd)).toEqual([f]);
		expect(touchedFiles("edit", { operations: [{ target: "a.ts:10-20" }] }, cwd)).toEqual([f]);
	});

	it("extracts create path", () => {
		expect(touchedFiles("create", { path: "new.ts" }, cwd)).toEqual([path.join(cwd, "new.ts")]);
	});

	it("returns nothing for non-FS-write tools", () => {
		expect(touchedFiles("org", { command: "set" }, cwd)).toEqual([]);
		expect(touchedFiles("find", { target: "x" }, cwd)).toEqual([]);
	});
});

// ----------------------------------------------------------------------------
// TransactionScope — snapshot / commit / rollback (real temp dir)
// ----------------------------------------------------------------------------

describe("TransactionScope", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(tmpdir(), "d3-txn-"));
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("captures an existing file and restores it on rollback", async () => {
		const f = path.join(dir, "a.txt");
		await fs.writeFile(f, "original");
		const scope = new TransactionScope(dir);

		await scope.capture("edit", { operations: [{ target: f }] });
		// Simulate the edit tool mutating the file (optimistic apply).
		await fs.writeFile(f, "MUTATED");
		expect(scope.size).toBe(1);

		const { restored, failures } = await scope.rollback();
		expect(failures).toEqual([]);
		expect(restored).toEqual([f]);
		expect(await fs.readFile(f, "utf-8")).toBe("original");
	});

	it("unlinks a newly-created file on rollback", async () => {
		const f = path.join(dir, "new.txt");
		const scope = new TransactionScope(dir);

		await scope.capture("create", { path: f });
		// Simulate create writing the file.
		await fs.writeFile(f, "created");
		expect(existsSync(f)).toBe(true);

		await scope.rollback();
		expect(existsSync(f)).toBe(false);
	});

	it("captures each file only ONCE (first touch = program-start state)", async () => {
		const f = path.join(dir, "a.txt");
		await fs.writeFile(f, "v0");
		const scope = new TransactionScope(dir);

		await scope.capture("edit", { operations: [{ target: f }] });
		await fs.writeFile(f, "v1");
		// Second touch must NOT re-snapshot (would capture v1, breaking rollback).
		await scope.capture("edit", { operations: [{ target: f }] });
		await fs.writeFile(f, "v2");
		expect(scope.size).toBe(1);

		await scope.rollback();
		// Restored to v0 (program start), not v1.
		expect(await fs.readFile(f, "utf-8")).toBe("v0");
	});

	it("commit drops snapshots (writes stay durable)", async () => {
		const f = path.join(dir, "a.txt");
		await fs.writeFile(f, "original");
		const scope = new TransactionScope(dir);

		await scope.capture("edit", { operations: [{ target: f }] });
		await fs.writeFile(f, "committed");
		scope.commit();
		expect(scope.size).toBe(0);

		// A rollback after commit is a no-op (snapshots gone).
		await scope.rollback();
		expect(await fs.readFile(f, "utf-8")).toBe("committed");
	});

	it("rolls back multiple files in reverse order", async () => {
		const a = path.join(dir, "a.txt");
		const b = path.join(dir, "b.txt");
		await fs.writeFile(a, "a0");
		const scope = new TransactionScope(dir);

		await scope.capture("edit", { operations: [{ target: a }] });
		await fs.writeFile(a, "a1");
		await scope.capture("create", { path: b });
		await fs.writeFile(b, "b-created");
		expect(scope.size).toBe(2);

		await scope.rollback();
		expect(await fs.readFile(a, "utf-8")).toBe("a0"); // restored
		expect(existsSync(b)).toBe(false); // unlinked
	});

	it("ignores non-FS-write tools", async () => {
		const scope = new TransactionScope(dir);
		await scope.capture("org", { command: "set" });
		await scope.capture("find", { target: "x" });
		expect(scope.size).toBe(0);
	});

	// --- W2 dynamic mixed-effect guard (the authoritative check) ---

	it("guard allows FS writes + reads", () => {
		const scope = new TransactionScope(dir);
		expect(() => {
			scope.guard("edit", "write");
			scope.guard("find", "read");
			scope.guard("create", "write");
		}).not.toThrow();
	});

	it("guard allows a non-FS mutation alone (no FS write yet)", () => {
		const scope = new TransactionScope(dir);
		expect(() => {
			scope.guard("org", "write");
			scope.guard("memory", "write");
		}).not.toThrow();
	});

	it("guard throws when FS write THEN non-FS mutation", () => {
		const scope = new TransactionScope(dir);
		scope.guard("edit", "write");
		expect(() => scope.guard("org", "write")).toThrow(MixedEffectError);
	});

	it("guard throws when non-FS mutation THEN FS write (order-independent)", () => {
		const scope = new TransactionScope(dir);
		scope.guard("memory", "write");
		expect(() => scope.guard("create", "write")).toThrow(MixedEffectError);
	});

	it("guard throws on FS write + exec/network", () => {
		const s1 = new TransactionScope(dir);
		s1.guard("edit", "write");
		expect(() => s1.guard("bash", "exec")).toThrow(MixedEffectError);
		const s2 = new TransactionScope(dir);
		s2.guard("create", "write");
		expect(() => s2.guard("fetch", "network")).toThrow(MixedEffectError);
	});

	it("guard is silent after settle (commit/rollback)", () => {
		const scope = new TransactionScope(dir);
		scope.guard("edit", "write");
		scope.commit();
		// After settle the guard no-ops (the program is done; nothing to protect).
		expect(() => scope.guard("org", "write")).not.toThrow();
	});

	// --- Review-fix regressions (D3 W1 reviewer swarm) ---

	it("[P1a] an unreadable EXISTING file is left untouched on rollback, never deleted", async () => {
		// A directory at the target path makes readFile fail with EISDIR (not ENOENT)
		// — the canonical 'exists but unreadable as a file' case. Rollback must NOT
		// rm it (that would be data loss); it must leave it and report a failure.
		const p = path.join(dir, "adir");
		await fs.mkdir(p);
		const scope = new TransactionScope(dir);
		await scope.capture("edit", { operations: [{ target: "adir" }] });
		expect(scope.size).toBe(1);

		const { restored, failures } = await scope.rollback();
		expect(restored).toEqual([]);
		expect(failures).toHaveLength(1);
		expect(failures[0].error).toContain("unreadable");
		// The directory must STILL EXIST (not deleted).
		expect(existsSync(p)).toBe(true);
	});

	it("[P2] a create path containing ':' is keyed verbatim (not stripped like an edit locator)", async () => {
		// 'notes:2024.md' is a legitimate filename; create writes it verbatim. If we
		// stripped ':2024.md' as a line-slice suffix, rollback would key 'notes' and
		// never unlink the real file.
		// 'log:42' ends in ':<digits>' — exactly the line-slice pattern the edit
		// locator-stripper removes. The OLD code stripped it to 'log' and rollback
		// missed the real file; create must key it verbatim.
		const name = "log:42";
		const scope = new TransactionScope(dir);
		await scope.capture("create", { path: name });
		// Simulate create writing the real (unstripped) file.
		await fs.writeFile(path.join(dir, name), "created");
		expect(existsSync(path.join(dir, name))).toBe(true);

		await scope.rollback();
		// Rollback must unlink the REAL file (keyed verbatim), leaving nothing behind.
		expect(existsSync(path.join(dir, name))).toBe(false);
	});

	it("[P3] concurrent same-path captures snapshot the program-START bytes", async () => {
		const f = path.join(dir, "shared.txt");
		await fs.writeFile(f, "START");
		const scope = new TransactionScope(dir);

		// Two concurrent capture()s of the same path (pmap fan-out shape). The second
		// must await the first's snapshot; neither may capture a mid-program value.
		// Interleave a write between the two capture awaits to exercise ordering.
		const c1 = scope.capture("edit", { operations: [{ target: "shared.txt" }] });
		const c2 = scope.capture("edit", { operations: [{ target: "shared.txt" }] });
		await Promise.all([c1, c2]);
		// A sibling write lands AFTER both captures resolved.
		await fs.writeFile(f, "MUTATED");
		expect(scope.size).toBe(1); // deduped to one snapshot

		await scope.rollback();
		expect(await fs.readFile(f, "utf-8")).toBe("START"); // program-start, not MUTATED
	});
});

// ----------------------------------------------------------------------------
// TransactionJournal — W3 crash-window recovery
// ----------------------------------------------------------------------------

describe("TransactionJournal (W3 crash recovery)", () => {
	let dir: string; // the workspace where files live
	let jdir: string; // the journal dir
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(tmpdir(), "d3-j-"));
		jdir = await fs.mkdtemp(path.join(tmpdir(), "d3-jrnl-"));
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
		await fs.rm(jdir, { recursive: true, force: true });
	});

	it("a scope persists its snapshot set to the journal as it captures", async () => {
		const journal = new TransactionJournal(jdir);
		const scope = new TransactionScope(dir, journal, 7);
		await fs.writeFile(path.join(dir, "a.txt"), "orig");
		await scope.capture("edit", { operations: [{ target: path.join(dir, "a.txt") }] });

		// A journal file now exists for this exec.
		const files = await fs.readdir(jdir);
		expect(files.some(f => f.includes("-7.json"))).toBe(true);
	});

	it("commit clears the journal", async () => {
		const journal = new TransactionJournal(jdir);
		const scope = new TransactionScope(dir, journal, 8);
		await fs.writeFile(path.join(dir, "a.txt"), "orig");
		await scope.capture("edit", { operations: [{ target: path.join(dir, "a.txt") }] });
		scope.commit();
		// commit's clear is async/best-effort; await a tick.
		await new Promise(r => setTimeout(r, 50));
		const files = await fs.readdir(jdir);
		expect(files.some(f => f.includes("-8.json"))).toBe(false);
	});

	// A pid that is reliably dead (well above any live pid), so sweep treats its
	// journal as a crashed prior run.
	const DEAD_PID = 999990;

	it("sweep recovers a DEAD process's writes (the decisive W3 property)", async () => {
		// Simulate a crash: hand-write a journal record (as if a DEAD prior process
		// left it) describing a created file and an edited file, then sweep — the
		// created file must be unlinked and the edited file restored.
		const created = path.join(dir, "new.txt");
		const edited = path.join(dir, "existing.txt");
		// Post-crash on-disk state: both files reflect the program's (uncommitted) writes.
		await fs.writeFile(created, "PARTIAL-CREATE");
		await fs.writeFile(edited, "PARTIAL-EDIT");

		// A journal from a DEAD pid. Snapshots = program-start state.
		const record = {
			execId: 1,
			startedAt: Date.now(),
			snapshots: [
				{ path: created, existed: false, content: null },
				{ path: edited, existed: true, content: "ORIGINAL" },
			],
		};
		// New filename format: txn-<pid>-<nonce>-<execId>.json.
		await fs.writeFile(path.join(jdir, `txn-${DEAD_PID}-abc123-1.json`), JSON.stringify(record));

		const { recovered, restored } = await new TransactionJournal(jdir).sweep();
		expect(recovered).toBe(1);
		expect(restored).toBe(2);
		// new.txt unlinked, existing.txt restored to ORIGINAL.
		expect(existsSync(created)).toBe(false);
		expect(await fs.readFile(edited, "utf-8")).toBe("ORIGINAL");
		// The journal file is consumed.
		expect((await fs.readdir(jdir)).length).toBe(0);
	});

	it("[P1 fix] sweep SKIPS a foreign journal whose pid is still ALIVE (no cross-process clobber)", async () => {
		// A live OTHER process's in-flight journal — use OUR pid (definitely alive) but
		// a different nonce, so it's foreign-but-live. sweep must NOT restore/delete it.
		const f = path.join(dir, "live.txt");
		await fs.writeFile(f, "LIVE-WRITE");
		const record = {
			execId: 3,
			startedAt: Date.now(),
			snapshots: [{ path: f, existed: true, content: "WOULD-CLOBBER" }],
		};
		const foreignButLive = path.join(jdir, `txn-${process.pid}-othernonce-3.json`);
		await fs.writeFile(foreignButLive, JSON.stringify(record));

		const { recovered } = await new TransactionJournal(jdir).sweep();
		expect(recovered).toBe(0);
		// The live process's file was NOT reverted, and its journal NOT deleted.
		expect(await fs.readFile(f, "utf-8")).toBe("LIVE-WRITE");
		expect(existsSync(foreignButLive)).toBe(true);
	});

	it("sweep leaves THIS journal instance's own live journals alone", async () => {
		// A scope using this journal writes a live journal; the same instance's sweep
		// must skip it (pid+nonce match).
		const journal = new TransactionJournal(jdir);
		const scope = new TransactionScope(dir, journal, 5);
		await fs.writeFile(path.join(dir, "a.txt"), "x");
		await scope.capture("edit", { operations: [{ target: path.join(dir, "a.txt") }] });
		const before = (await fs.readdir(jdir)).length;
		expect(before).toBe(1);
		const { recovered } = await journal.sweep();
		expect(recovered).toBe(0);
		expect((await fs.readdir(jdir)).length).toBe(1); // untouched
	});

	it("sweep skips an unreadable-at-capture file (never deletes it)", async () => {
		const p = path.join(dir, "keep");
		await fs.writeFile(p, "present");
		const record = {
			execId: 2,
			startedAt: Date.now(),
			snapshots: [{ path: p, existed: true, content: null }], // unreadable marker
		};
		await fs.writeFile(path.join(jdir, `txn-${DEAD_PID}-n-2.json`), JSON.stringify(record));
		await new TransactionJournal(jdir).sweep();
		// Left untouched (not deleted, not clobbered).
		expect(await fs.readFile(p, "utf-8")).toBe("present");
	});

	it("sweep tolerates an unparseable journal file", async () => {
		await fs.writeFile(path.join(jdir, `txn-${DEAD_PID}-n-9.json`), "{ not json");
		const { recovered, restored } = await new TransactionJournal(jdir).sweep();
		expect(recovered).toBe(0);
		expect(restored).toBe(0);
	});
});

// ----------------------------------------------------------------------------
// assertTransactionSafe — W2 preflight (D3.4 mixed-effect guard)
// ----------------------------------------------------------------------------

describe("assertTransactionSafe", () => {
	const check = (program: string) => assertTransactionSafe(program, extractToolCalls, effectOf);

	it("allows FS writes alone (rollback-able)", () => {
		expect(() => check(`(tool/edit {:operations [{:target "a.ts"}]}) (tool/create {:path "b"})`)).not.toThrow();
	});

	it("allows FS writes mixed with READS (reads need no rollback)", () => {
		expect(() =>
			check(`(let [r (tool/find {:target "x"})] (tool/edit {:operations [{:target "a.ts"}]}))`),
		).not.toThrow();
	});

	it("allows FS writes mixed with org QUERY (read sub-command)", () => {
		expect(() =>
			check(`(tool/org {:command "query"}) (tool/edit {:operations [{:target "a.ts"}]})`),
		).not.toThrow();
	});

	it("allows a non-FS mutation ALONE (no FS write to be inconsistent with)", () => {
		// org set alone is fine — D3 just doesn't snapshot it; nothing to be torn.
		expect(() => check(`(tool/org {:command "set" :id "X" :property "p" :value "v"})`)).not.toThrow();
		expect(() => check(`(tool/memory {:action "save" :title "t"})`)).not.toThrow();
	});

	it("REJECTS FS write + org set (non-rollback-able mutation)", () => {
		expect(() =>
			check(`(tool/edit {:operations [{:target "a.ts"}]}) (tool/org {:command "set" :id "X"})`),
		).toThrow(MixedEffectError);
	});

	it("REJECTS FS write + memory save", () => {
		expect(() =>
			check(`(tool/create {:path "a"}) (tool/memory {:action "save" :title "t"})`),
		).toThrow(MixedEffectError);
	});

	it("REJECTS FS write + side-effecting bash (exec)", () => {
		expect(() => check(`(tool/edit {:operations [{:target "a.ts"}]}) (tool/bash {:command "rm x"})`)).toThrow(
			MixedEffectError,
		);
	});

	it("REJECTS FS write + org with a COMPUTED sub-command (might be a mutation)", () => {
		expect(() => check(`(tool/edit {:operations [{:target "a.ts"}]}) (tool/org {:command cmd})`)).toThrow(
			MixedEffectError,
		);
	});

	it("names both the FS tool and the unsafe tool in the error", () => {
		try {
			check(`(tool/edit {:operations [{:target "a.ts"}]}) (tool/memory {:action "note" :text "x"})`);
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(MixedEffectError);
			expect((e as MixedEffectError).fsTool).toBe("edit");
			expect((e as MixedEffectError).unsafeTool).toBe("memory");
		}
	});
});

// ----------------------------------------------------------------------------
// Integration — real BEAM: the decisive E4 property
// ----------------------------------------------------------------------------

const runtimeDir = path.resolve(import.meta.dirname, "..", "..", "..", "..", "..", "beam", "ptc_runtime");
const runnable =
	spawnSync("mix", ["--version"], { stdio: "ignore" }).status === 0 &&
	existsSync(path.join(runtimeDir, "_build"));
const d = runnable ? describe : describe.skip;

/**
 * A fake `create`/`edit` tool that actually writes to disk (so rollback has
 * something to undo), bound to a temp dir.
 */
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
			for (const op of ops) {
				const p = path.join(dir, op.target);
				await fs.writeFile(p, op.content ?? "edited");
			}
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

d("D3 transactional write lane (real BEAM)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(tmpdir(), "d3-e2e-"));
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("create-edit-BOOM leaves the repo clean (the decisive E4 test)", async () => {
		// A pre-existing file the program will edit then must see restored.
		await fs.writeFile(path.join(dir, "b.txt"), "B-ORIGINAL");

		const tool = new ExecuteTool({ cwd: dir } as never, {
			policy: PERMISSIVE_POLICY,
			provider: provider(fsWriteTools(dir)),
		});
		try {
			// Program: create a.txt, edit b.txt, then FAIL. Both writes happen
			// (optimistic apply), then the fail-signal triggers rollback.
			const program = `
				(tool/create {:path "a.txt" :content "A-NEW"})
				(tool/edit {:operations [{:target "b.txt" :content "B-EDITED"}]})
				(fail "boom")`;
			const res = await tool.execute("c1", { program });

			expect(res.isError).toBe(true);
			// a.txt was created then rolled back → must NOT exist.
			expect(existsSync(path.join(dir, "a.txt"))).toBe(false);
			// b.txt was edited then rolled back → must be the ORIGINAL.
			expect(await fs.readFile(path.join(dir, "b.txt"), "utf-8")).toBe("B-ORIGINAL");
			// The error text notes the rollback.
			expect(res.content[0]?.type === "text" && res.content[0].text).toContain("Rolled back");
		} finally {
			await tool.dispose();
		}
	}, 30_000);

	it("a successful program COMMITS its writes (no rollback)", async () => {
		const tool = new ExecuteTool({ cwd: dir } as never, {
			policy: PERMISSIVE_POLICY,
			provider: provider(fsWriteTools(dir)),
		});
		try {
			const program = `
				(tool/create {:path "a.txt" :content "A-NEW"})
				(tool/edit {:operations [{:target "a.txt" :content "A-FINAL"}]})
				"done"`;
			const res = await tool.execute("c1", { program });

			expect(res.isError).toBeFalsy();
			expect(res.data).toBe("done");
			// The write is durable (committed, not rolled back).
			expect(await fs.readFile(path.join(dir, "a.txt"), "utf-8")).toBe("A-FINAL");
		} finally {
			await tool.dispose();
		}
	}, 30_000);

	it("W2 dynamic guard blocks a mixed FS-write + org-set program; the FS write rolls back", async () => {
		// create a.txt runs (FS write, snapshotted), THEN org-set dispatches — the
		// dynamic guard throws BEFORE org runs (org never mutates), the program fails,
		// and a.txt rolls back. Net: NO torn state (a.txt gone, org never ran).
		const orgCalls: unknown[] = [];
		const orgTool: DispatchableTool = {
			name: "org",
			async execute(_id, args) {
				orgCalls.push(args);
				return { content: [], data: { ok: true } } as AgentToolResult;
			},
		};
		const tool = new ExecuteTool({ cwd: dir } as never, {
			policy: PERMISSIVE_POLICY,
			provider: provider([...fsWriteTools(dir), orgTool]),
		});
		try {
			const program = `(tool/create {:path "a.txt"}) (tool/org {:command "set" :id "X"})`;
			const res = await tool.execute("c1", { program });
			expect(res.isError).toBe(true);
			expect(res.content[0]?.type === "text" && res.content[0].text).toContain("all-or-nothing");
			// org-set was BLOCKED before it ran (the guard threw at its dispatch).
			expect(orgCalls).toHaveLength(0);
			// a.txt was created then ROLLED BACK → gone. No torn state.
			expect(existsSync(path.join(dir, "a.txt"))).toBe(false);
		} finally {
			await tool.dispose();
		}
	}, 30_000);

	it("W2 dynamic guard catches a VALUE-POSITION write tool the static scan misses", async () => {
		// The P1 evasion: bind a write tool as a value and invoke it indirectly. A
		// static text scan never sees `(w {:command "set"})` as an org call, but the
		// dynamic guard (at dispatch, by resolved name) does — so the mix is still
		// blocked and the FS write rolls back.
		const orgCalls: unknown[] = [];
		const orgTool: DispatchableTool = {
			name: "org",
			async execute(_id, args) {
				orgCalls.push(args);
				return { content: [], data: { ok: true } } as AgentToolResult;
			},
		};
		const tool = new ExecuteTool({ cwd: dir } as never, {
			policy: PERMISSIVE_POLICY,
			provider: provider([...fsWriteTools(dir), orgTool]),
		});
		try {
			// `tool/org` bound to `w`, invoked indirectly — a regex preflight can't see it.
			const program = `(let [w tool/org] (tool/create {:path "a.txt"}) (w {:command "set" :id "X"}))`;
			const res = await tool.execute("c1", { program });
			expect(res.isError).toBe(true);
			// The indirect org-set was BLOCKED (guard fired at its dispatch).
			expect(orgCalls).toHaveLength(0);
			// a.txt rolled back — no torn state despite the evasion attempt.
			expect(existsSync(path.join(dir, "a.txt"))).toBe(false);
		} finally {
			await tool.dispose();
		}
	}, 30_000);

	it("a read-only program opens no rollback (nothing captured)", async () => {
		await fs.writeFile(path.join(dir, "x.txt"), "X");
		const tool = new ExecuteTool({ cwd: dir } as never, {
			policy: PERMISSIVE_POLICY,
			provider: provider(fsWriteTools(dir)),
		});
		try {
			// No writes; a fail must not produce a rollback note (size 0).
			const res = await tool.execute("c1", { program: `(fail "no writes")` });
			expect(res.isError).toBe(true);
			expect(res.content[0]?.type === "text" && res.content[0].text).not.toContain("Rolled back");
			expect(await fs.readFile(path.join(dir, "x.txt"), "utf-8")).toBe("X");
		} finally {
			await tool.dispose();
		}
	}, 30_000);
});

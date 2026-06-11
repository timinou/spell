/**
 * Transactional write lane (D3 / PLAN-333) — all-or-nothing program effects.
 *
 * ## The problem (error class E4)
 *
 * A PTC-Lisp `execute` program runs tool calls one at a time. A program that
 * mutates then errors leaves PARTIAL EFFECTS:
 *
 * ```clojure
 * (tool/create {:path "a.txt" …})   ; committed to disk
 * (tool/edit {:target "b.rs" …})    ; committed to disk
 * (boom)                            ; error → program "fails" but a.txt + b.rs already landed
 * ```
 *
 * The program reports failure, so the agent may retry → double-apply. This is
 * the only error class that silently CORRUPTS the repo.
 *
 * ## The mechanism: optimistic-apply + rollback (program-scoped)
 *
 * D3 lifts the per-call strict-transaction snapshot/rollback already in the
 * `edit` tool (snapshot a file's bytes before mutating; restore on failure) from
 * SINGLE-CALL scope to WHOLE-PROGRAM scope:
 *
 *   - a {@link TransactionScope} opens per execute program;
 *   - before each FS-write tool call (`edit`/`create`), the scope captures the
 *     BEFORE-state of every file that call will touch — on FIRST touch only, so
 *     the snapshot is the file's state at program start, not its last mid-program
 *     value;
 *   - the tool then runs and commits to disk as today (optimistic apply);
 *   - program SUCCESS → commit is a no-op (writes already durable); drop snapshots;
 *   - program ERROR / fail-signal → rollback: restore every snapshot in REVERSE
 *     capture order (a file created mid-program is unlinked; a file edited is
 *     restored to its captured bytes).
 *
 * This is optimistic-apply + rollback, NOT deferred-commit (nothing-on-disk-
 * until-success). Deferred-commit would need a staging VFS the write tools route
 * through, which does not exist. Optimistic-apply + rollback FULLY kills E4 (the
 * create-edit-boom program leaves the repo clean) with one narrow residual: a
 * hard process crash mid-program before rollback runs — addressed by the W3
 * snapshot-set journal, and strictly better than today (where EVERY error leaks
 * partial effects).
 *
 * ## Scope boundary
 *
 * Only FS-write tools whose effect is plain-file restore-rollback-able are
 * snapshotted here: `edit`, `create`. Stores that are NOT plain-file revertible
 * (`org` set/update, `memory` save/note, `todo_write`) and non-rollback-able
 * effects (side-effecting `bash`) are OUT of this lane — a program mixing them
 * with FS writes is rejected at the W2 preflight boundary (honest D3.4: the lane
 * covers edits/creates; it does not pretend to roll back an org mutation).
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { resolveCwdRelativePath } from "../path-resolution";

/**
 * A captured file state, restored on rollback.
 *
 * `content` semantics:
 *  - existed=false           → content null → rollback UNLINKS (file was absent).
 *  - existed=true, content=s → rollback REWRITES the bytes `s`.
 *  - existed=true, content=null → file existed but was UNREADABLE at capture
 *    (EACCES/EBUSY/EISDIR/…); rollback LEAVES IT UNTOUCHED — we must not delete
 *    a pre-existing file nor clobber it with empty bytes we never read.
 */
interface FileSnapshot {
	/** Absolute on-disk path (the locator, no `::Symbol`/`#qual`/`:A-B` suffix). */
	readonly path: string;
	/** Whether the file existed at capture time. */
	readonly existed: boolean;
	/** Captured bytes; null = absent (existed=false) OR unreadable (existed=true). */
	readonly content: string | null;
}

/** The set of tools whose writes are plain-file restore-rollback-able. */
export const FS_WRITE_TOOLS: ReadonlySet<string> = new Set(["edit", "create"]);

/** The on-disk shape of a journalled transaction (one file per live program). */
interface JournalRecord {
	readonly execId: number;
	readonly startedAt: number;
	readonly snapshots: FileSnapshot[];
}

/**
 * Crash-window recovery journal (W3). Optimistic-apply means FS writes land on
 * disk AS the program runs; rollback (on program error) restores them. The one
 * residual gap: a HARD process crash mid-program — after a write, before the
 * in-memory rollback runs — would strand partial effects (the in-memory snapshots
 * die with the process).
 *
 * The journal closes that window: as each snapshot is captured it is persisted to
 * a per-program file; a CLEAN settle (commit or rollback) deletes the file; a
 * crash leaves it behind. On the next ExecuteTool startup, {@link sweep} finds
 * any leftover journal — a program that never settled — and restores its
 * snapshots, then deletes it. Net: even a kill -9 mid-program self-heals on
 * restart, strictly better than today (every error leaks).
 *
 * The journal is best-effort and NON-fatal: a journal write/read failure never
 * blocks or breaks a program (the in-memory rollback remains the primary path);
 * it only narrows the crash window. Default location: ~/.spell/execute-txn-journal.
 */
export class TransactionJournal {
	/**
	 * A per-LAUNCH nonce. The journal filename carries `<pid>-<nonce>` so sweep can
	 * tell a journal THIS process authored (skip — live) from a foreign one, AND
	 * survive pid reuse: a recycled pid from a crashed prior run has a DIFFERENT
	 * nonce, so it is not mistaken for our own live journal.
	 */
	private readonly nonce: string;

	constructor(private readonly dir: string = defaultJournalDir()) {
		// Boot-unique: pid alone is reused across launches; the random suffix makes a
		// crashed prior run's journal distinguishable from this run's.
		this.nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
	}

	/** Filename for one of OUR programs: txn-<pid>-<nonce>-<execId>.json. */
	private file(execId: number): string {
		return nodePath.join(this.dir, `txn-${process.pid}-${this.nonce}-${execId}.json`);
	}

	/**
	 * Persist the current snapshot set for a live program. Best-effort and ATOMIC:
	 * writes a temp sibling then renames over the target (rename is atomic on the
	 * same fs), so a crash mid-write — or a concurrent pmap-fan-out write to the
	 * same file — never leaves a TORN record that sweep would mis-parse.
	 */
	async write(execId: number, startedAt: number, snapshots: FileSnapshot[]): Promise<void> {
		try {
			await fs.mkdir(this.dir, { recursive: true });
			const rec: JournalRecord = { execId, startedAt, snapshots };
			const target = this.file(execId);
			// Unique temp name per write so concurrent captures don't collide on the temp.
			const tmp = `${target}.${Math.random().toString(36).slice(2, 8)}.tmp`;
			await fs.writeFile(tmp, JSON.stringify(rec), "utf-8");
			await fs.rename(tmp, target);
		} catch {
			// Journalling is a safety net, never a gate — a failure here just narrows
			// (doesn't widen) the crash window; the in-memory rollback still works.
		}
	}

	/** Remove a program's journal after a CLEAN settle (commit/rollback). Best-effort. */
	async clear(execId: number): Promise<void> {
		try {
			await fs.rm(this.file(execId), { force: true });
		} catch {
			/* best-effort */
		}
	}

	/**
	 * Recover stranded transactions from a CRASHED process. Reads every journal in
	 * the dir; for each, restores its snapshots (existed→rewrite bytes, absent→
	 * unlink, unreadable→leave) and deletes it. Returns a summary. Called once at
	 * ExecuteTool startup. Best-effort, isolated per file.
	 *
	 * LIVENESS (the multi-process guarantee): a journal is recovered ONLY if its
	 * owning pid is DEAD. A foreign journal whose pid is still ALIVE belongs to a
	 * concurrently-running process — restoring it would clobber that process's
	 * in-flight writes — so it is SKIPPED. Our OWN journals (matching pid+nonce)
	 * are live programs and skipped too. Pid reuse is handled by the nonce: a
	 * recycled pid that is alive but whose nonce ≠ ours is some OTHER live process
	 * (skip); a dead pid is recovered regardless of nonce.
	 */
	async sweep(): Promise<{ recovered: number; restored: number }> {
		let recovered = 0;
		let restored = 0;
		let entries: string[];
		try {
			entries = await fs.readdir(this.dir);
		} catch {
			return { recovered: 0, restored: 0 }; // no dir = nothing to recover
		}
		const mine = `txn-${process.pid}-${this.nonce}-`;
		for (const name of entries) {
			if (!name.startsWith("txn-") || !name.endsWith(".json")) continue;
			// Our own live journals: never touch.
			if (name.startsWith(mine)) continue;
			// Parse the owning pid from txn-<pid>-<nonce>-<execId>.json.
			const pid = Number(name.slice("txn-".length).split("-")[0]);
			// A foreign journal whose pid is still ALIVE is another running process's
			// in-flight transaction — restoring it would revert its live writes. Skip.
			if (Number.isFinite(pid) && isPidAlive(pid)) continue;
			const file = nodePath.join(this.dir, name);
			try {
				const rec = JSON.parse(await fs.readFile(file, "utf-8")) as JournalRecord;
				for (let i = rec.snapshots.length - 1; i >= 0; i--) {
					const snap = rec.snapshots[i];
					if (snap.existed && snap.content === null) continue; // unreadable: leave
					try {
						if (snap.existed) {
							await fs.mkdir(nodePath.dirname(snap.path), { recursive: true });
							await fs.writeFile(snap.path, snap.content ?? "", "utf-8");
						} else {
							await fs.rm(snap.path, { force: true });
						}
						restored++;
					} catch {
						/* best-effort per file */
					}
				}
				recovered++;
			} catch {
				/* unparseable (e.g. torn) journal: skip, leave for manual inspection */
				continue;
			}
			await fs.rm(file, { force: true }).catch(() => {});
		}
		return { recovered, restored };
	}
}

/** True if a process with `pid` is currently alive (signal-0 probe). */
function isPidAlive(pid: number): boolean {
	if (pid <= 0) return false;
	try {
		process.kill(pid, 0); // no signal sent; throws ESRCH if dead, EPERM if alive-but-foreign
		return true;
	} catch (e) {
		// EPERM = the process EXISTS but we can't signal it (different user) → ALIVE.
		// ESRCH = no such process → dead.
		return (e as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

/** Default crash-journal location: ~/.spell/execute-txn-journal. */
export function defaultJournalDir(): string {
	return nodePath.join(os.homedir(), ".spell", "execute-txn-journal");
}

/**
 * Extract the on-disk file paths an FS-write tool call will touch, resolved
 * against `cwd` exactly as the tools themselves resolve (so rollback keys match
 * the bytes the tool wrote). Returns absolute locator paths (the `::Symbol`,
 * `#body`/`#sig`, and `:A-B` suffixes stripped — those address sub-spans, not
 * the file).
 *
 * - `edit`: `operations[].target` (one or more).
 * - `create`: `path`.
 *
 * A target that cannot be resolved to a path is skipped (the tool will surface
 * its own error; we cannot snapshot what we cannot locate).
 */
export function touchedFiles(tool: string, args: Record<string, unknown>, cwd: string): string[] {
	const out: string[] = [];
	if (tool === "edit") {
		const ops = Array.isArray(args.operations) ? args.operations : [];
		for (const op of ops) {
			const target = (op as { target?: unknown })?.target;
			if (typeof target !== "string") continue;
			// edit INTERPRETS ::Symbol / #qual / :A-B as sub-span locators, so the
			// real on-disk file is the locator part only — strip them, identical to
			// edit.ts's filePart derivation (otherwise rollback keys a phantom path).
			const resolved = resolveCwdRelativePath(cwd, target, { mode: "file" });
			const filePart = resolved.path
				.split("::")[0]!
				.split("#")[0]!
				.replace(/:\d+(?:-\d*)?$/, "");
			out.push(filePart);
		}
	} else if (tool === "create") {
		// create writes params.path VERBATIM — it does NOT interpret ::/#/:N as a
		// locator. Stripping them here would mis-key rollback for a legitimate
		// filename containing those chars (e.g. "notes:2024", "a::b.txt"), leaving
		// the created file un-unlinked. Resolve the path WITHOUT suffix stripping.
		if (typeof args.path === "string") {
			out.push(resolveCwdRelativePath(cwd, args.path, { mode: "file" }).path);
		}
	}
	return out;
}

/**
 * Raised at preflight when a program mixes rollback-able FS writes with a
 * mutation D3 CANNOT roll back (honest D3.4).
 */
export class MixedEffectError extends Error {
	constructor(
		readonly fsTool: string,
		readonly unsafeTool: string,
	) {
		super(
			`transactional write lane cannot make this program all-or-nothing: it mixes a ` +
				`rollback-able file write ('${fsTool}') with a non-rollback-able effect ('${unsafeTool}'). ` +
				`If '${unsafeTool}' ran and a later step failed, the file writes would roll back but ` +
				`'${unsafeTool}'s effect would persist — leaving inconsistent state. Split the program so the ` +
				`file edits and the '${unsafeTool}' mutation run separately (each can then fail cleanly).`,
		);
		this.name = "MixedEffectError";
	}
}

/**
 * Effects D3 can faithfully roll back: only plain-file FS writes (edit/create),
 * whose before-state is captured and restorable. Everything else that MUTATES
 * — org set/update, memory save/note/link, todo_write (managed stores), and any
 * exec/network side effect (bash, task, fetch) — is NOT file-restore-rollback-able.
 */
function isRollbackable(tool: string): boolean {
	return FS_WRITE_TOOLS.has(tool);
}

/**
 * W2 preflight (D3.4) — reject a program that mixes a rollback-able FS write with
 * a non-rollback-able mutation, BEFORE it runs (0 effects). Such a program cannot
 * be made all-or-nothing: a partial failure would roll back the files but leave
 * the org/memory/bash effect, the inconsistent state D3 exists to prevent.
 *
 * Classification (per `(tool/NAME …)` call, reusing the effect taxonomy):
 *  - FS write (edit/create)                     → rollback-able.
 *  - write-effect non-FS tool (org set, memory   → non-rollback-able MUTATION.
 *    save, todo_write)
 *  - exec/network (bash/task/fetch/web_search)   → non-rollback-able SIDE EFFECT.
 *  - pure/read                                   → irrelevant (no effect).
 *
 * A computed sub-command on a mixed-effect tool (e.g. `(tool/org {:command cmd})`)
 * is treated conservatively as a possible mutation — it MIGHT be `set`, so a
 * program mixing it with FS writes is rejected (the author splits, or uses a
 * literal read sub-command).
 *
 * `effectOf(tool, args)` is injected so the taxonomy stays single-sourced.
 */
export function assertTransactionSafe(
	program: string,
	extractCalls: (p: string) => Array<{ name: string; command?: string; action?: string; computedSubcommand: boolean }>,
	effectOf: (tool: string, args?: Record<string, unknown>) => string,
): void {
	const calls = extractCalls(program);
	let fsWrite: string | undefined;
	let unsafe: string | undefined;

	for (const call of calls) {
		if (isRollbackable(call.name)) {
			fsWrite ??= call.name;
			continue;
		}
		// Resolve the call's effect with its literal sub-command (so `org query`
		// stays `read` and doesn't trip the guard). A computed sub-command yields no
		// args → the tool keeps its conservative static (highest) effect.
		const args: Record<string, unknown> = {};
		if (call.command !== undefined) args.command = call.command;
		if (call.action !== undefined) args.action = call.action;
		const effect = effectOf(call.name, Object.keys(args).length > 0 ? args : undefined);
		// A non-FS-write tool whose effect is a MUTATION or SIDE EFFECT is the
		// non-rollback-able partner. pure/read are harmless.
		if (effect === "write" || effect === "exec" || effect === "network") {
			unsafe ??= call.name;
		}
	}

	if (fsWrite && unsafe) throw new MixedEffectError(fsWrite, unsafe);
}

/**
 * A program-scoped transaction. One per execute program. Captures FS-write
 * snapshots as the program runs; commits (no-op) on success or rolls back on
 * failure.
 */
export class TransactionScope {
	/** Snapshots in capture order; rollback replays them in REVERSE. */
	private readonly snapshots: FileSnapshot[] = [];
	/**
	 * In-flight / completed capture promise per path. Serves two roles:
	 *  - dedup: a path is captured only ONCE (first touch = program-start state);
	 *  - ORDERING: a concurrent sibling tool_call (pmap fan-out) that touches the
	 *    same path awaits the FIRST capture's readFile before it can proceed to
	 *    write, so the snapshot is the program-start bytes, never a mid-program
	 *    value the sibling already wrote.
	 */
	private readonly capturing = new Map<string, Promise<void>>();
	private settled = false;
	/**
	 * Dynamic mixed-effect tracking (W2, the real guarantee). The static preflight
	 * `assertTransactionSafe` is a best-effort EARLY hint; it cannot see a write
	 * tool invoked in VALUE position (`(let [w tool/org] (w {:command "set"}))`)
	 * because it is a text scan. This pair, updated at DISPATCH (where every call
	 * is seen by resolved name + effect), is the authoritative guard: the moment a
	 * scope holds BOTH a rollback-able FS write and a non-rollback-able mutation,
	 * `guard` throws — catching indirect/higher-order calls the regex misses.
	 */
	private fsWriteTool: string | undefined;
	private unsafeTool: string | undefined;

	/**
	 * Optional crash-window journal (W3). When present, the snapshot set is
	 * persisted after each capture and cleared on settle, so a hard process crash
	 * mid-program self-heals on the next startup sweep. Absent → in-memory only.
	 */
	constructor(
		private readonly cwd: string,
		private readonly journal?: TransactionJournal,
		private readonly execId?: number,
		private readonly startedAt: number = Date.now(),
	) {}

	/** Number of files captured (for cost-meter / tests). */
	get size(): number {
		return this.snapshots.length;
	}

	/** The captured file paths (for a preview/audit surface). */
	get paths(): string[] {
		return this.snapshots.map(s => s.path);
	}

	/**
	 * Dynamic mixed-effect guard (W2). Called by the dispatcher for EVERY tool
	 * call (after the scope is open, before the tool runs), with the resolved tool
	 * name and its dispatch-time effect. Records whether this scope has seen an
	 * FS write and/or a non-rollback-able mutation; throws {@link MixedEffectError}
	 * the instant BOTH coexist — so a program that tries to tear state (FS write +
	 * org-set, in ANY syntactic form) is stopped at the SECOND of the two calls,
	 * before it runs. Seeing every call at dispatch closes the value-position
	 * evasion the static preflight cannot.
	 */
	guard(tool: string, effect: string): void {
		if (this.settled) return;
		if (FS_WRITE_TOOLS.has(tool)) {
			this.fsWriteTool ??= tool;
		} else if (effect === "write" || effect === "exec" || effect === "network") {
			// A non-FS-write tool with a mutating/side-effecting effect is the
			// non-rollback-able partner. (pure/read are harmless.)
			this.unsafeTool ??= tool;
		}
		if (this.fsWriteTool && this.unsafeTool) {
			throw new MixedEffectError(this.fsWriteTool, this.unsafeTool);
		}
	}

	/**
	 * Capture the BEFORE-state of every file an FS-write tool call will touch,
	 * BEFORE the call runs. First touch of a file wins (its program-start state);
	 * later touches await that first capture (so a concurrent same-path sibling
	 * cannot race its own write ahead of the snapshot). A no-op for non-FS-write
	 * tools. AWAIT this fully before letting the tool run.
	 */
	async capture(tool: string, args: Record<string, unknown>): Promise<void> {
		if (this.settled) return;
		if (!FS_WRITE_TOOLS.has(tool)) return;
		const pending: Array<Promise<void>> = [];
		for (const path of touchedFiles(tool, args, this.cwd)) {
			let inflight = this.capturing.get(path);
			if (!inflight) {
				inflight = this.snapshotPath(path);
				this.capturing.set(path, inflight);
			}
			// Await even an ALREADY-started capture: a sibling that touches the same
			// path must not proceed to write until the first snapshot's read settles.
			pending.push(inflight);
		}
		await Promise.all(pending);
		// W3: persist the snapshot set to the crash journal BEFORE the tool runs, so
		// a hard crash during the tool's write is recoverable on the next startup
		// sweep. Best-effort — never blocks the program.
		if (this.journal && this.execId !== undefined && this.snapshots.length > 0) {
			await this.journal.write(this.execId, this.startedAt, this.snapshots);
		}
	}

	/**
	 * Snapshot one path. Distinguishes a genuinely-absent file (ENOENT) from an
	 * existing-but-unreadable one: an unreadable EXISTING file is recorded as
	 * existed=true with content=null so rollback NEVER deletes it (it leaves it
	 * untouched) — deleting a pre-existing file we merely couldn't read would be
	 * data loss worse than no rollback.
	 */
	private async snapshotPath(path: string): Promise<void> {
		let snap: FileSnapshot;
		try {
			const content = await fs.readFile(path, "utf-8");
			snap = { path, existed: true, content };
		} catch (e) {
			const code = (e as NodeJS.ErrnoException)?.code;
			if (code === "ENOENT") {
				// Genuinely absent at program start → rollback unlinks it if created.
				snap = { path, existed: false, content: null };
			} else {
				// Exists but unreadable (EACCES/EBUSY/EISDIR/EMFILE/…) → mark existed so
				// rollback's not-existed unlink branch can NEVER fire for it. content
				// is null = "cannot restore bytes"; rollback leaves it untouched.
				snap = { path, existed: true, content: null };
			}
		}
		this.snapshots.push(snap);
	}

	/**
	 * Commit the transaction (program succeeded). With optimistic-apply the
	 * writes are already durable, so commit only drops the snapshots. Idempotent.
	 */
	commit(): void {
		this.settled = true;
		this.snapshots.length = 0;
		this.capturing.clear();
		// W3: a clean settle — drop the crash journal (nothing to recover). Async,
		// best-effort; keeping commit() sync for callers (a leftover journal would at
		// worst be a harmless no-op re-restore of already-committed bytes on sweep).
		if (this.journal && this.execId !== undefined) void this.journal.clear(this.execId);
	}

	/**
	 * Roll back the transaction (program errored / emitted a fail-signal). Restore
	 * every captured file in REVERSE order: a file that existed is rewritten to its
	 * captured bytes; a file that did not exist is unlinked. Returns the list of
	 * restored paths (for the cost meter / result surface). Best-effort per file:
	 * a restore that itself fails is collected into `failures` rather than aborting
	 * the remaining restores — a partial rollback is still strictly better than
	 * leaving every effect.
	 */
	async rollback(): Promise<{ restored: string[]; failures: Array<{ path: string; error: string }> }> {
		this.settled = true;
		const restored: string[] = [];
		const failures: Array<{ path: string; error: string }> = [];
		// Reverse: undo later effects before earlier ones (a create then edit of the
		// same new file restores correctly — though first-touch dedup makes that a
		// single snapshot anyway).
		for (let i = this.snapshots.length - 1; i >= 0; i--) {
			const snap = this.snapshots[i];
			// Unreadable-existing: bytes unknown — leave the file exactly as-is. We can
			// neither restore (no bytes) nor delete (it existed). Skipping is the only
			// non-destructive choice; surface it as a failure so it's visible.
			if (snap.existed && snap.content === null) {
				failures.push({
					path: snap.path,
					error: "file was unreadable at capture; left as-is (cannot restore bytes)",
				});
				continue;
			}
			try {
				if (snap.existed) {
					await fs.mkdir(nodePath.dirname(snap.path), { recursive: true });
					await fs.writeFile(snap.path, snap.content ?? "", "utf-8");
				} else {
					await fs.rm(snap.path, { force: true });
				}
				restored.push(snap.path);
			} catch (e) {
				failures.push({ path: snap.path, error: e instanceof Error ? e.message : String(e) });
			}
		}
		this.snapshots.length = 0;
		this.capturing.clear();
		// W3: rollback completed in-process — the crash journal is no longer needed.
		if (this.journal && this.execId !== undefined) await this.journal.clear(this.execId);
		return { restored, failures };
	}
}

/**
 * A registry of live transaction scopes keyed by execute id. The dispatcher
 * captures into the scope for a tool call's `execId`; the ExecuteTool opens a
 * scope before running a program and settles it (commit/rollback) after.
 *
 * Concurrent executes each get their own scope (executes can overlap; admission
 * ceiling is 8). A tool call with no `execId` (non-program caller) is a no-op.
 */
export class TransactionRegistry {
	private readonly scopes = new Map<number, TransactionScope>();

	/**
	 * @param journal optional crash-window journal (W3); passed to every scope so
	 * a hard crash mid-program self-heals on the next startup sweep.
	 */
	constructor(private readonly journal?: TransactionJournal) {}

	/** Open a scope for an execute. Replaces any stale scope under the same id. */
	open(execId: number, cwd: string): TransactionScope {
		const scope = new TransactionScope(cwd, this.journal, execId);
		this.scopes.set(execId, scope);
		return scope;
	}

	/** The live scope for an execute, or undefined if none is open. */
	get(execId: number | undefined): TransactionScope | undefined {
		return execId === undefined ? undefined : this.scopes.get(execId);
	}

	/** Drop a scope (after its program settles). Idempotent. */
	close(execId: number): void {
		this.scopes.delete(execId);
	}
}

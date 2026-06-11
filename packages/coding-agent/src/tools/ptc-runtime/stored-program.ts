/**
 * Stored programs (W4) — a PTC-Lisp program as a durable, re-runnable value.
 *
 * A normal `execute` program is ephemeral: written, run once, discarded. A
 * *stored* program is persisted (in a memory playbook, an org tile, a canvas
 * panel) and re-executed later by a new caller — a save, a dashboard tick, a
 * refresh. The substrate that makes this SAFE (offload, settled fan-out,
 * bindings, the session-store reaper, strict accessors) already shipped; this
 * module is the thin storage + invocation contract on top.
 *
 * ## Scope: READ-ONLY (W4-read)
 *
 * This module enforces that a stored program performs no repo/project
 * mutations. A read/aggregate program (find/org-query/memory-search/bash-read)
 * has no effects to roll back, so it is safe to store and re-run unattended
 * today. WRITE-flavored stored programs are gated on the transactional write
 * lane (D3 / PLAN-333) and land via the W4-write follow-up (FUP-112) — a
 * stored program that mutates and fails halfway would otherwise leave partial
 * effects on every failed tick.
 *
 * ## The three guards (enforced at STORE time, not first run)
 *
 *   1. read-only   every `(tool/NAME …)` call must resolve to a `pure`/`read`
 *                  effect under {@link effects.effectOf} — reusing the SAME
 *                  effect taxonomy the live capability policy uses, so the
 *                  classifier can never drift from the runtime gate.
 *   2. preflight   the program parses + has no unknown builtins/vars. (Runs
 *                  via the real runtime at store time — see
 *                  `validateStoredProgram` — so a typo can never be persisted
 *                  as a live tile and then fail effectfully on a tick.)
 *   3. signature   an optional output contract, re-validated on every run by
 *                  the existing execute path.
 *
 * ## Effect refinement (why name-only checking is not enough)
 *
 * `org` is statically tagged `write` (its highest effect), but
 * `(tool/org {:command "dashboard"})` only READS — the canonical W4 tile. The
 * guard therefore extracts each tool call's literal `:command`/`:action`
 * sub-command and passes it to `effectOf`, which RELAXES `org`/`memory` to
 * `read` for their read-only sub-commands. A tool call whose sub-command is
 * *computed* (not a string literal) cannot be proven read-only, so it is
 * treated at the tool's static (highest) effect — conservatively rejected. The
 * guard never admits a write; at worst it over-rejects a rare computed-command
 * read, and the error tells the author to split the program.
 */

import { effectOf, type EffectTag } from "./effects";
import { assertTransactionSafe, MixedEffectError } from "./transaction";

/**
 * A durable, re-runnable PTC-Lisp program. Stored as a value (a fenced block
 * in a memory/org body — text-first, diff-able, travels as a value) and fed to
 * the execute lane to re-run.
 */
export interface StoredProgram {
	/** The PTC-Lisp source. Lint-clean at store time. */
	readonly program: string;
	/** Optional output contract, validated on every run. */
	readonly signature?: string;
	/** Static data bound under `data/<key>` (the D-6 convention). */
	readonly context?: Record<string, unknown>;
	/** Human label. */
	readonly title: string;
	/**
	 * Effect mode (W4-write). Determines the STORE-time bar:
	 * - `"read"` (default) — pure/read only; rejected if it mutates (W4-read,
	 *   `assertReadOnly`).
	 * - `"write"` — may edit/create FILES; rides D3's transactional lane. Held to
	 *   the rollback-safe bar (`assertTransactionSafe`): file writes are allowed,
	 *   but mixing them with non-rollback-able mutations (org-set / memory-save /
	 *   bash) is rejected — a partial failure could roll back the files but not the
	 *   org/memory change. Reads mix freely.
	 */
	readonly mode?: "read" | "write";
}

/** A tool call extracted from a program: its name and literal sub-command, if any. */
export interface ExtractedToolCall {
	readonly name: string;
	/** Literal `:command "…"` arg, when present as a string literal. */
	readonly command?: string;
	/** Literal `:action "…"` arg, when present as a string literal. */
	readonly action?: string;
	/** True when the call has a sub-command arg that is NOT a string literal. */
	readonly computedSubcommand: boolean;
}

/** Raised when a stored program would mutate state (violates W4-read). */
export class StoredProgramWriteError extends Error {
	readonly tool: string;
	readonly effect: EffectTag;
	constructor(tool: string, effect: EffectTag, detail: string) {
		super(
			`stored program is not read-only: tool '${tool}' resolves to effect ` +
				`'${effect}'. ${detail} W4 stored programs are read-only; a program ` +
				`that mutates needs the transactional write lane (D3 / PLAN-333) and ` +
				`lands via W4-write (FUP-112).`,
		);
		this.name = "StoredProgramWriteError";
		this.tool = tool;
		this.effect = effect;
	}
}

/**
 * Tool-call matcher: `(tool/NAME` where NAME is a tool symbol. We then scan the
 * immediately following arg map for a literal `:command "…"` / `:action "…"`.
 *
 * NB: this is a deliberately shallow scan — it reads only the literal
 * sub-command directly after the tool symbol. A computed sub-command (no string
 * literal) is flagged `computedSubcommand` and treated conservatively.
 */
const TOOL_CALL = /\(\s*tool\/([A-Za-z][\w-]*)/g;
const COMMAND_LITERAL = /^\s*\{?\s*:command\s+"([^"]*)"/;
const ACTION_LITERAL = /^\s*\{?\s*:action\s+"([^"]*)"/;
/** A sub-command keyword present but NOT followed by a string literal → computed. */
const COMMAND_KEYWORD = /^\s*\{?\s*:command\s+(?!")/;
const ACTION_KEYWORD = /^\s*\{?\s*:action\s+(?!")/;

/**
 * Extract every `(tool/NAME …)` call from a program with its literal
 * sub-command (when statically present). Used by the read-only guard.
 */
export function extractToolCalls(program: string): ExtractedToolCall[] {
	const calls: ExtractedToolCall[] = [];
	for (const m of program.matchAll(TOOL_CALL)) {
		const name = m[1];
		// Look at the text immediately after the tool symbol for a literal
		// sub-command arg. The arg map opens right after `(tool/NAME`.
		const after = program.slice(m.index + m[0].length);
		const cmd = COMMAND_LITERAL.exec(after);
		const act = ACTION_LITERAL.exec(after);
		const computed =
			(!cmd && COMMAND_KEYWORD.test(after)) || (!act && ACTION_KEYWORD.test(after));
		calls.push({
			name,
			command: cmd?.[1],
			action: act?.[1],
			computedSubcommand: computed,
		});
	}
	return calls;
}

/** Effects a stored read-only program may use. */
const READ_ONLY_EFFECTS: ReadonlySet<EffectTag> = new Set<EffectTag>(["pure", "read"]);

/** Outcome of validating a candidate stored program at STORE time. */
export type StoredProgramValidation =
	| { ok: true }
	/** A read-mode program that mutates (W4-read bar). */
	| { ok: false; reason: "not-read-only"; tool: string; effect: EffectTag; message: string }
	/** A write-mode program that mixes FS writes with a non-rollback-able mutation (D3 bar). */
	| { ok: false; reason: "not-rollback-safe"; fsTool: string; unsafeTool: string; message: string }
	/** Either mode: the program doesn't parse or uses unknown builtins/vars. */
	| { ok: false; reason: "preflight"; errors: string[] };

/** A parse-only validator: confirms a program parses + uses no unknown symbols. */
export type ProgramValidator = (program: string) => Promise<{ ok: boolean; errors?: string[] }>;

/**
 * Validate a candidate stored program at STORE time. Runs the two structural
 * guards in order — cheapest/most-decisive first:
 *   1. read-only  (static, synchronous) — reject a mutating program up front.
 *   2. preflight  (via `validate`, 0 effects) — reject a typo'd / unparseable
 *      program so it can never be persisted then fail effectfully on a re-run.
 * The signature guard (3) is enforced by the execute path on every run, not here.
 *
 * `validate` is injected (an `ExecuteTool.validateProgram` binding) so this
 * module stays decoupled from the runtime client.
 */
export async function validateStoredProgram(
	stored: Pick<StoredProgram, "program" | "mode">,
	validate: ProgramValidator,
): Promise<StoredProgramValidation> {
	const mode = stored.mode ?? "read";

	// Guard 1 — the MODE bar (static, no runtime needed). Fail fast.
	if (mode === "read") {
		// W4-read: pure/read only — any mutation is rejected.
		try {
			assertReadOnly(stored.program);
		} catch (e) {
			if (e instanceof StoredProgramWriteError) {
				return { ok: false, reason: "not-read-only", tool: e.tool, effect: e.effect, message: e.message };
			}
			throw e;
		}
	} else {
		// W4-write: file writes ARE allowed, but the program must be ROLLBACK-SAFE —
		// it must not mix FS writes (edit/create) with a non-rollback-able mutation
		// (org-set / memory-save / bash). This is exactly D3's W2 guarantee, reused at
		// store time as an early static hint. (The DYNAMIC guard at dispatch is still
		// the authoritative runtime check — this catches the obvious case at store.)
		try {
			assertTransactionSafe(stored.program, extractToolCalls, effectOf);
		} catch (e) {
			if (e instanceof MixedEffectError) {
				return {
					ok: false,
					reason: "not-rollback-safe",
					fsTool: e.fsTool,
					unsafeTool: e.unsafeTool,
					message: e.message,
				};
			}
			throw e;
		}
	}

	// Guard 2 — preflight (parse + unknown-symbol check, 0 effects). Both modes.
	const pre = await validate(stored.program);
	if (!pre.ok) return { ok: false, reason: "preflight", errors: pre.errors ?? ["program failed to parse"] };

	return { ok: true };
}

/**
 * Guard 1 — assert a program is read-only. Throws {@link StoredProgramWriteError}
 * on the first tool call that resolves to a mutating/exec/network effect.
 *
 * For each `(tool/NAME …)`: resolve its effect via `effectOf(NAME, subcommand)`.
 * A literal `:command`/`:action` refines `org`/`memory` to `read` where
 * applicable. A computed sub-command on a statically-write tool cannot be proven
 * read-only → treated at the tool's static effect (rejected).
 */
export function assertReadOnly(program: string): void {
	for (const call of extractToolCalls(program)) {
		// Build the args the refiner inspects. A literal sub-command lets
		// effectOf relax org/memory to `read`; a computed one is omitted so the
		// tool keeps its conservative static (highest) effect.
		const args: Record<string, unknown> = {};
		if (call.command !== undefined) args.command = call.command;
		if (call.action !== undefined) args.action = call.action;

		const effect = effectOf(call.name, Object.keys(args).length > 0 ? args : undefined);

		if (!READ_ONLY_EFFECTS.has(effect)) {
			const detail = call.computedSubcommand
				? `Its sub-command is computed (not a string literal), so it cannot be ` +
					`proven read-only — split the program so the stored part only reads.`
				: `That tool mutates state.`;
			throw new StoredProgramWriteError(call.name, effect, detail);
		}
	}
}

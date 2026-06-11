/**
 * The `execute` tool — Spell's deterministic-compute coprocessor.
 *
 * An agent submits a PTC-Lisp program; Spell runs it in a sandboxed BEAM
 * runtime (ptc_runner) that can call back into Spell's real tools via the
 * bridge. The program orchestrates tool calls, filters, and aggregates *inside
 * the sandbox*, returning one small (optionally signature-validated) value —
 * replacing fragile multi-turn Bash pipelines with a single deterministic
 * program.
 *
 *   {program, context?, signature?, timeout_ms?} → the program's return value
 *
 * ## Lifecycle
 *
 * One long-lived BEAM runtime per tool instance (≈ per session), spawned lazily
 * on first `execute` and hydrated with a generated tool + provider catalog.
 * `dispose()` tears it down. A supervisor-restarted Peer is transparently
 * re-initialized by the client (see PtcRuntimeClient).
 *
 * ## Capability policy
 *
 * Tool calls a program makes are gated by a `CapabilityPolicy` (effects.ts /
 * policy.ts). V1 default = read + write (no exec, no network). The catalog
 * advertised to the runtime is pre-filtered to the policy-allowed tools, and
 * the bridge re-checks at dispatch time (defense in depth).
 */

import { type Static, Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@spell/pi-agent-core";
import executeDescription from "../../prompts/tools/execute.md" with { type: "text" };
import type { ArtifactRef } from "../../session/artifacts";
import type { ToolSession } from "../index";
import { generateToolCatalog } from "./catalog-gen";
import { buildSessionToolProvider } from "./catalog-session";
import { type Catalog, PtcRuntimeClient, PtcRuntimeError, spawnTransport } from "./client";
import { isMapOfSignature, parseMapSignature, validateMapValue } from "./map-signature";
import { allowedTools, type CapabilityPolicy, DEFAULT_POLICY } from "./policy";
import { makeToolDispatcher, type ToolProvider } from "./tool-dispatch";
import { TransactionJournal, TransactionRegistry } from "./transaction";

export const executeSchema = Type.Object({
	program: Type.String({ description: "PTC-Lisp program to evaluate in the sandbox." }),
	context: Type.Optional(
		Type.Record(Type.String(), Type.Any(), {
			description: "Data bound under data/<key> inside the program.",
		}),
	),
	signature: Type.Optional(Type.String({ description: "Optional PTC-Lisp return signature, e.g. '{total :int}'." })),
	timeout_ms: Type.Optional(Type.Integer({ description: "Wall-clock cap in ms (1..30000, default 1000)." })),
	max_heap_mb: Type.Optional(
		Type.Integer({
			description:
				"Sandbox heap ceiling in MB for THIS program (default ~50MB). Clamped to the tools.executeMaxHeapMb setting when set, and to 256MB always.",
		}),
	),
	session_store_mb: Type.Optional(
		Type.Integer({
			description:
				"Session-scoped data store ceiling in MB (default ~64MB). Set via tools.executeSessionStoreMb.",
		}),
	),
	// ----- W4 stored-program fields (a tile / consumer invokes runStored via the
	// tool surface by setting these). When `mode` or `intent` is present, the
	// execute tool routes to the intent-gated stored-program runner instead of a
	// plain interactive run. Absent → unchanged plain `execute` behaviour. -----
	mode: Type.Optional(
		Type.Union([Type.Literal("read"), Type.Literal("write")], {
			description:
				"Stored-program effect mode (W4). 'read' (default) discards any write; 'write' permits file edits/creates, transactionally, gated by `intent`.",
		}),
	),
	intent: Type.Optional(
		Type.Union([Type.Literal("interactive"), Type.Literal("visible-refresh"), Type.Literal("background-tick")], {
			description:
				"Run intent (W4). 'interactive' commits writes; 'visible-refresh' dry-runs them into a preview (no mutation); 'background-tick' is inert unless `auto_write` is set.",
		}),
	),
	auto_write: Type.Optional(
		Type.Boolean({
			description: "Permit a write program to mutate on a 'background-tick' intent (W4). Default false (inert).",
		}),
	),
});

export type ExecuteParams = Static<typeof executeSchema>;

/**
 * Persists a large result to session-scoped artifact storage (PLAN-325).
 * Mirrors `SessionManager.saveArtifact`; returns the artifact ref or undefined
 * when the session is not persisted.
 */
export type SaveArtifact = (
	content: string | Uint8Array,
	toolType: string,
	extension?: string,
) => Promise<ArtifactRef | undefined>;

/**
 * Structured outcome of a program's D3 transaction (W4-write / D3.5 cost meter).
 * A caller (a stored-program tile/runner) RENDERS from this; it never recomputes
 * rollback logic. `none` = a read-only program that made no file writes.
 */
export interface TxnOutcome {
	/**
	 * committed   writes kept (program succeeded).
	 * rolled-back program failed → every write restored.
	 * dry-run     a deliberate preview (visible-refresh) or a read-only backstop
	 *             discard → program ran, writes captured then rolled back, repo
	 *             untouched.
	 * inert       the run was SKIPPED entirely (unarmed background-tick) — the
	 *             program never executed; a tile keeps its last known state.
	 * none        the program ran and made no file writes.
	 */
	readonly outcome: "committed" | "rolled-back" | "dry-run" | "inert" | "none";
	/** Number of files the transaction touched (committed / restored / previewed). */
	readonly files: number;
	/** The touched file paths (for a preview/audit surface). */
	readonly paths?: string[];
	/** Paths that could not be restored on rollback (rare; surfaced loudly). */
	readonly restoreFailures?: string[];
}

export interface ExecuteToolDetails {
	program: string;
	signature?: string;
	durationMs?: number;
	/** Set when an over-large result was handed off to an artifact (PLAN-325). */
	artifactUri?: string;
	/** The D3 transaction outcome for this run (W4-write). Absent for a no-op. */
	transaction?: TxnOutcome;
}

/**
 * Why a stored program is being run (W4-write). The intent — supplied by the
 * CALLER, a property of the run context not the program — decides whether a
 * WRITE program actually mutates:
 * - `interactive`      an agent/user explicitly ran it → writes execute for real.
 * - `visible-refresh`  a dashboard/canvas is OPEN, a human is present → the write
 *                      program runs as a DRY RUN (a "would change N files" preview,
 *                      no mutation). The preview IS the product for a watcher.
 * - `background-tick`  a scheduled tick, nobody watching → the write program is
 *                      INERT unless the tile is explicitly armed (`autoWrite`), so a
 *                      background job never silently mutates the repo.
 */
export type RunIntent = "interactive" | "visible-refresh" | "background-tick";

/**
 * A runnable stored program — the runtime-relevant subset of StoredProgram.
 * `title` is accepted (a full StoredProgram is assignable) but unused at runtime.
 */
export interface StoredProgramInput {
	readonly program: string;
	readonly signature?: string;
	readonly context?: Record<string, unknown>;
	readonly mode?: "read" | "write";
	readonly title?: string;
}

/** Options for {@link ExecuteTool.runStored}. */
export interface RunStoredOptions {
	/** Run context (default `interactive`). Decides write behaviour — see {@link RunIntent}. */
	readonly intent?: RunIntent;
	/** Per-tile opt-in: allow a WRITE program to mutate on a `background-tick`. */
	readonly autoWrite?: boolean;
	/** Aborts the tool_calls this run issues. */
	readonly signal?: AbortSignal;
}

export class ExecuteTool implements AgentTool<typeof executeSchema, ExecuteToolDetails> {
	readonly name = "execute";
	readonly label = "Execute";
	readonly description = executeDescription;
	readonly parameters = executeSchema;

	private readonly session?: ToolSession;
	private readonly policy: CapabilityPolicy;
	private readonly provider?: ToolProvider;
	private readonly saveArtifact?: SaveArtifact;
	private client: PtcRuntimeClient | null = null;
	private initPromise: Promise<void> | null = null;
	/**
	 * D3: per-program transaction scopes. The dispatcher captures FS-write
	 * snapshots into the scope for a tool call's exec_id; this tool opens a scope
	 * before each program and settles it (commit on success / rollback on error).
	 * Backed by a crash-window journal (W3) so a hard process crash mid-program
	 * self-heals on the next startup sweep.
	 */
	private readonly txnJournal = new TransactionJournal();
	private readonly transactions = new TransactionRegistry(this.txnJournal);

	constructor(
		session?: ToolSession,
		opts?: { policy?: CapabilityPolicy; provider?: ToolProvider; saveArtifact?: SaveArtifact },
	) {
		this.session = session;
		this.policy = opts?.policy ?? DEFAULT_POLICY;
		this.provider = opts?.provider;
		// Default the artifact sink to one built from the session's output-artifact
		// allocator, so an over-large result is handed off rather than truncated when
		// running in a persisted session (PLAN-325).
		this.saveArtifact = opts?.saveArtifact ?? defaultSaveArtifact(session);
		// W3 crash recovery: on startup, sweep any transaction journals stranded by a
		// PRIOR crashed process (a program that wrote files then died before its
		// rollback ran) and restore them. Fire-and-forget — recovery must never block
		// tool construction; a failure here leaves the journal for the next attempt.
		void this.txnJournal.sweep().catch(() => {});
	}

	async execute(
		_toolCallId: string,
		params: ExecuteParams,
		signal?: AbortSignal,
		_onUpdate?: unknown,
		context?: AgentToolContext,
	): Promise<AgentToolResult> {
		// W4: when the caller supplies stored-program fields (`mode`/`intent`/
		// `auto_write`), route through the intent-gated stored runner so the tool
		// surface — and therefore any host that invokes a tool (a Team Chat tile, a
		// canvas armed button) — can express visible-refresh previews, inert ticks,
		// and the read-only backstop. Absent → a plain interactive run (unchanged).
		if (params.mode !== undefined || params.intent !== undefined) {
			return this.runStored(
				{
					program: params.program,
					signature: params.signature,
					context: params.context,
					mode: params.mode,
				},
				{ intent: params.intent, autoWrite: params.auto_write, signal },
				context,
			);
		}
		return this.#runProgram(params, {}, signal, context);
	}

	/**
	 * The shared program-run path (W4-write). `execute` (the public tool entry) and
	 * `runStored` (the stored-program runner) both funnel here.
	 *
	 * @param opts.dryRun when true, a SUCCESSFUL program's file writes are FORCE-
	 *   ROLLED-BACK instead of committed — the program ran for real (reads, compute)
	 *   but the repo is left untouched, and the result's `details.transaction.outcome`
	 *   is `"dry-run"`. This powers the visible-refresh PREVIEW: "would change N
	 *   files" with zero mutation. (An error still rolls back as normal.)
	 */
	async #runProgram(
		params: ExecuteParams,
		opts: { dryRun?: boolean; readOnly?: boolean },
		signal?: AbortSignal,
		context?: AgentToolContext,
	): Promise<AgentToolResult> {
		const started = Date.now();
		// `dryRun` and `readOnly` both force a SUCCESSFUL program's writes to roll
		// back instead of commit — the repo is left untouched. They differ only in
		// INTENT/reporting:
		//  - dryRun   = a deliberate PREVIEW (visible-refresh) → outcome "dry-run".
		//  - readOnly = a SAFETY BACKSTOP: this run must not mutate (a read-mode
		//    program, or an unarmed tick), so if the program wrote anything it is a
		//    contract violation — discard the writes and report it. outcome "dry-run"
		//    with a violation note. This makes an omitted/mislabeled mode SAFE-BY-
		//    DISCARD rather than a silent commit.
		const forceRollback = opts.dryRun === true || opts.readOnly === true;
		const readOnlyBackstop = opts.readOnly === true;
		// D3.4 (W2) mixed-effect guard. The AUTHORITATIVE check is DYNAMIC, in the
		// dispatcher (`TransactionScope.guard`): it sees every tool call by resolved
		// name + effect, so it catches a write tool invoked in value position that a
		// static text scan cannot, and throws MixedEffectError mid-program — caught
		// below, rolling back any FS write already made while BLOCKING the mutation
		// that would tear state.
		//
		// A static preflight (`assertTransactionSafe`) could reject obvious mixes
		// earlier with 0 effects, but a regex text scan false-rejects calls appearing
		// in strings/comments and can't see value-position calls — so it is NOT used
		// as a hard gate here; the dynamic guard is the guarantee. (`assertTransactionSafe`
		// remains exported for an advisory lint surface.)
		//
		// D3: the execute id of THIS program, captured the instant the client
		// allocates it (before any tool_call), so the dispatcher's snapshot capture
		// and our commit/rollback key the same scope. A re-init retry re-invokes
		// onExecId with the retry's id; we close the prior scope and open the new one.
		let execId: number | undefined;
		const openScope = (id: number) => {
			// A transparent re-init retry re-invokes this with a NEW id. The prior
			// attempt's scope may already hold snapshots from tool_calls it ran before
			// the not-initialized error surfaced. Dropping them would strand those
			// writes (attempt-1 effects that can never roll back). ROLL BACK the prior
			// scope so the retry starts from a clean slate — all-or-nothing holds
			// across the retry boundary. Fire-and-forget: the rollback races nothing
			// (attempt 2 hasn't issued writes yet) and a failure is best-effort like
			// any rollback.
			if (execId !== undefined) {
				const prior = this.transactions.get(execId);
				if (prior && prior.size > 0) void prior.rollback();
				this.transactions.close(execId);
			}
			execId = id;
			this.transactions.open(id, this.session?.cwd ?? process.cwd());
		};
		try {
			const client = await this.ensureClient(context);
			// F2: ptc_runner's grammar can't express a homogeneous map-of signature
			// ({:string :int}) — the natural shape of group-by/frequencies output. When
			// the signature uses that dialect, WITHHOLD it from ptc_runner (it would
			// reject the grammar) and validate the returned value Spell-side instead.
			const mapOf = params.signature && isMapOfSignature(params.signature) ? params.signature : undefined;
			const nativeSignature = mapOf ? undefined : params.signature;

			const value = await client.execute({
				program: params.program,
				context: params.context,
				signature: nativeSignature,
				timeoutMs: params.timeout_ms,
				maxHeapWords: this.resolveMaxHeapWords(params.max_heap_mb),
				sessionStoreBytes: this.resolveSessionStoreBytes(params.session_store_mb),
				// Per-execute signal: the client composes it with its own teardown
				// signal and threads it into THIS execute's tool_calls only (PLAN-324).
				signal,
				onExecId: openScope,
			});

			if (mapOf) validateAgainstMapSignature(value, mapOf);

			// D3 + W4-write: settle the transaction.
			//  - normal success            → COMMIT (writes already durable).
			//  - forceRollback (dry-run /   → force-ROLLBACK so the repo is untouched.
			//    read-only backstop)          dryRun reports a deliberate "dry-run"
			//                                 PREVIEW; readOnly reports a CONTRACT
			//                                 VIOLATION (a run that must not mutate, did).
			let transaction: TxnOutcome | undefined;
			let readOnlyViolation = 0;
			if (execId !== undefined) {
				const scope = this.transactions.get(execId);
				if (scope) {
					const files = scope.size;
					const paths = scope.paths;
					if (forceRollback && files > 0) {
						const { restored, failures } = await scope.rollback();
						if (readOnlyBackstop) readOnlyViolation = restored.length;
						transaction = {
							outcome: "dry-run",
							files: restored.length,
							paths,
							...(failures.length ? { restoreFailures: failures.map(f => f.path) } : {}),
						};
					} else {
						scope.commit();
						transaction = { outcome: files > 0 ? "committed" : "none", files, ...(files ? { paths } : {}) };
					}
				}
				this.transactions.close(execId);
			}

			// A dry-run that found writes is reported as an error-free PREVIEW, but the
			// `data` payload is still the program's real return value (e.g. the count).
			const rendered = await this.#renderResult(value);
			const dryRunNote = readOnlyViolation
				? `\n\nThis run is read-only but the program attempted ${readOnlyViolation} file write(s) — ` +
					`DISCARDED, repo NOT modified. (Store this program with mode:"write" to allow writes.)`
				: transaction?.outcome === "dry-run"
					? `\n\nDry run: would change ${transaction.files} file(s) — repo NOT modified.`
					: "";
			return {
				content: [{ type: "text", text: rendered.text + dryRunNote }],
				details: {
					program: params.program,
					signature: params.signature,
					durationMs: Date.now() - started,
					...(rendered.artifactUri ? { artifactUri: rendered.artifactUri } : {}),
					...(transaction ? { transaction } : {}),
				},
				// The program's return value IS the payload — the whole point of execute.
				data: value,
			};
		} catch (e) {
			// D3: program errored / emitted a fail-signal → roll back every FS write it
			// made, so a create-edit-boom program leaves the repo clean (kills E4). The
			// rollback outcome is surfaced in the error text so a partial-restore (rare)
			// is visible rather than silent.
			let rollbackNote = "";
			let transaction: TxnOutcome | undefined;
			if (execId !== undefined) {
				const scope = this.transactions.get(execId);
				if (scope && scope.size > 0) {
					const paths = scope.paths;
					const { restored, failures } = await scope.rollback();
					rollbackNote =
						failures.length === 0
							? `\n\nRolled back ${restored.length} file write(s) — repo restored to pre-program state.`
							: `\n\nRolled back ${restored.length} file write(s); ${failures.length} could not be restored: ` +
								`${failures.map(f => f.path).join(", ")}. Inspect these manually.`;
					transaction = {
						outcome: "rolled-back",
						files: restored.length,
						paths,
						...(failures.length ? { restoreFailures: failures.map(f => f.path) } : {}),
					};
				}
				this.transactions.close(execId);
			}
			return {
				content: [{ type: "text", text: renderError(e) + rollbackNote }],
				details: {
					program: params.program,
					signature: params.signature,
					durationMs: Date.now() - started,
					...(transaction ? { transaction } : {}),
				},
				data: null,
				isError: true,
			};
		}
	}

	async dispose(): Promise<void> {
		this.client?.close();
		this.client = null;
		this.initPromise = null;
	}

	/**
	 * Render a return value for the model, capped in size (PLAN-325).
	 *
	 * Small results render inline. An over-large result is handed off to an
	 * artifact (full value preserved, programmatically retrievable via the URI)
	 * and the model sees a bounded head preview + the `artifact://` URI instead of
	 * a flooded turn. When no artifact sink is available (unpersisted session) it
	 * degrades to the in-line truncation marker.
	 */
	async #renderResult(value: unknown): Promise<{ text: string; artifactUri?: string }> {
		const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
		if (text.length <= MAX_RESULT_BYTES) return { text };

		const head = text.slice(0, MAX_RESULT_BYTES);
		if (this.saveArtifact) {
			try {
				const ext = typeof value === "string" ? "txt" : "json";
				const ref = await this.saveArtifact(text, "execute", ext);
				if (ref) {
					return {
						artifactUri: ref.uri,
						text:
							`${head}\n\n[result is ${text.length} bytes; full value saved to ${ref.uri} ` +
							`(showing first ${MAX_RESULT_BYTES}). Read that artifact for the rest, ` +
							`or aggregate further / use a signature to return a smaller value.]`,
					};
				}
			} catch {
				// Artifact write failed (e.g. unpersisted session) → fall through to truncation.
			}
		}
		return { text: truncationMarker(head, text.length) };
	}

	/** Session-settings binding for the module-level resolver (FEAT-791). */
	private resolveMaxHeapWords(requestedMb?: number): number | undefined {
		const setting = this.session?.settings?.get("tools.executeMaxHeapMb") ?? 0;
		return resolveMaxHeapWords(setting, requestedMb);
	}

	/**
	 * Resolve the session-store ceiling in bytes from the operator setting. If the
	 * setting is unset (0 or absent), uses the runtime default (64 MB). Conversion
	 * from MB to bytes happens exactly once here.
	 */
	private resolveSessionStoreBytes(requestedMb?: number): number | undefined {
		const setting = this.session?.settings?.get("tools.executeSessionStoreMb") ?? 0;
		return resolveSessionStoreBytes(setting, requestedMb);
	}

	// ----- stored programs (W4 / FEAT-810) -----

	/**
	 * Parse-only validation of a program (W4 store-time preflight). Runs ZERO
	 * tool calls and ZERO effects: confirms the program parses and references no
	 * unknown builtins/vars. Resolves `{ ok, errors? }` where errors carry the
	 * runtime's "Did you mean" hints. Used to reject a typo'd stored program at
	 * STORE time so it can never be persisted and then fail effectfully on a
	 * later re-run.
	 */
	async validateProgram(
		program: string,
		context?: AgentToolContext,
	): Promise<{ ok: boolean; errors?: string[] }> {
		const client = await this.ensureClient(context);
		return client.validate(program);
	}

	/**
	 * Re-run a stored program through the ONE execute invocation path (so a
	 * stored tile, a memory playbook, and a canvas panel all share spawn,
	 * effects-gating, rendering, and artifact-handoff). The stored program's
	 * `context` becomes the execute `context`; its `signature` is re-validated on
	 * every run. Callers SHOULD have validated read-only-ness + preflight at
	 * store time (see {@link stored-program.validateStoredProgram}); this method
	 * is the runtime side and re-checks nothing structural.
	 */
	async runStored(
		stored: StoredProgramInput,
		opts: RunStoredOptions = {},
		context?: AgentToolContext,
	): Promise<AgentToolResult> {
		const mode = stored.mode ?? "read";
		const intent = opts.intent ?? "interactive";
		const runParams = { program: stored.program, signature: stored.signature, context: stored.context };

		// SAFETY-FIRST gating (W4-write). The protection keys on INTENT + a runtime
		// READ-ONLY BACKSTOP — NOT on the declared `mode` alone — so an omitted or
		// mislabeled mode can never cause a silent commit (the failure this feature
		// exists to prevent). `mode` only enables the inert OPTIMIZATION for a
		// declared-write tick; it never WIDENS what may mutate.
		//
		//  read mode        → readOnly backstop ALWAYS: the program runs, but any file
		//                     write it makes is DISCARDED (rolled back) and reported.
		//                     A read program that secretly writes never mutates.
		//  write +
		//   interactive     → writes COMMIT (an agent/user explicitly ran it).
		//   visible-refresh → DRY RUN preview (writes captured, rolled back, repo clean).
		//   background-tick → armed (autoWrite) ? COMMIT : INERT (program never runs).
		if (mode !== "write") {
			// Read mode (incl. omitted) — never commit a write, in ANY intent.
			return this.#runProgram(runParams, { readOnly: true }, opts.signal, context);
		}

		switch (intent) {
			case "visible-refresh":
				return this.#runProgram(runParams, { dryRun: true }, opts.signal, context);
			case "background-tick":
				if (!opts.autoWrite) {
					// Inert: the program never executes; the tile keeps its last state.
					return {
						content: [
							{ type: "text", text: "Skipped: write program on an unarmed background tick (autoWrite off)." },
						],
						details: {
							program: stored.program,
							signature: stored.signature,
							transaction: { outcome: "inert", files: 0 },
						},
						data: null,
					};
				}
				return this.#runProgram(runParams, {}, opts.signal, context);
			default: // interactive
				return this.#runProgram(runParams, {}, opts.signal, context);
		}
	}

	// ----- lifecycle -----

	private async ensureClient(context?: AgentToolContext): Promise<PtcRuntimeClient> {
		// Respawn a dead runtime: if the OS process exited (whole-VM death, not a
		// supervisor-restartable Peer crash), the client is permanently closed.
		// Drop it so the next execute spawns a fresh runtime (PLAN-324).
		if (this.client?.closed) {
			this.client = null;
			this.initPromise = null;
		}
		if (this.client) return this.client;
		// Single-flight init: concurrent executes share one spawn.
		if (!this.initPromise) this.initPromise = this.spawn(context);
		try {
			await this.initPromise;
		} catch (e) {
			// A failed spawn must not poison every future execute with a cached
			// rejected promise; clear it so the next call retries.
			this.initPromise = null;
			throw e;
		}
		if (!this.client) throw new Error("PtcRuntime client failed to initialize");
		return this.client;
	}

	private async spawn(context?: AgentToolContext): Promise<void> {
		const provider = this.provider ?? this.defaultProvider();
		const catalogTools = generateToolCatalog(provider.catalogTools());

		// Advertise only policy-permitted tools to the runtime (pre-filter); the
		// dispatcher re-checks at call time (defense in depth).
		const permitted = new Set(
			allowedTools(
				catalogTools.map(t => t.name),
				this.policy,
			),
		);
		const catalog: Catalog = {
			tools: catalogTools.filter(t => permitted.has(t.name)),
		};

		const { transport } = spawnTransport({});
		const client = new PtcRuntimeClient({
			transport,
			onToolCall: makeToolDispatcher({
				// Resolve the instance UNCONDITIONALLY; enforcePolicy (inside the
				// dispatcher) is the independent second gate. The catalog pre-filter
				// (above) and this dispatch check derive from the same policy but run
				// at different layers, so a denied tool is caught even if it somehow
				// leaked into the advertised catalog (Review Gate 3, P3).
				lookup: name => provider.lookup(name),
				policy: this.policy,
				// No dispatch-level signal: the long-lived runtime is shared across
				// many executes, so per-call signals (supplied by the client per
				// tool_call, scoped to the originating execute) are the correct and
				// ONLY abort source. A spawn-time signal here would be the first
				// execute's — wrong for every later one (PLAN-324).
				context,
				// D3: the dispatcher captures FS-write snapshots into the scope for a
				// tool call's exec_id BEFORE the tool mutates, so a program error can
				// roll back. One registry per ExecuteTool, shared across the runtime's
				// concurrent executes (each keyed by its own exec_id).
				transactions: this.transactions,
			}),
		});

		await client.init(catalog, this.resolveSessionStoreBytes());
		this.client = client;
	}

	/**
	 * Default provider: lazily instantiate the session's builtin tools and read
	 * their schemas. Tools requiring a session are skipped when none is present
	 * (e.g. in minimal contexts), yielding an empty catalog rather than failing.
	 */
	private defaultProvider(): ToolProvider {
		return buildSessionToolProvider(this.session);
	}
}

// ----- map-of signature validation (F2) -----

/**
 * Validate a returned value against a Spell-dialect map-of signature. Throws a
 * PtcRuntimeError-shaped error on mismatch so it renders through the same
 * `(parse_error)`/`(validation)` channel as a native signature failure.
 */
function validateAgainstMapSignature(value: unknown, signature: string): void {
	const parsed = parseMapSignature(signature);
	if (!parsed.ok) {
		throw new PtcRuntimeError({
			code: -32602,
			message: `invalid map-of signature: ${parsed.error}`,
			data: { reason: "parse_error" },
		});
	}
	const mismatch = validateMapValue(value, parsed.type);
	if (mismatch) {
		throw new PtcRuntimeError({
			code: -32602,
			message: `return value does not match signature '${signature}': ${mismatch}`,
			data: { reason: "validation" },
		});
	}
}

/**
 * Build a SaveArtifact from a session's output-artifact allocator (alloc path +
 * write the bytes). Returns undefined when the session can't persist artifacts,
 * so the caller falls back to in-line truncation.
 */
function defaultSaveArtifact(session?: ToolSession): SaveArtifact | undefined {
	if (!session?.allocateOutputArtifact) return undefined;
	const alloc = session.allocateOutputArtifact.bind(session);
	return async (content, toolType, extension) => {
		const ref = await alloc(toolType, extension);
		if (!ref) return undefined;
		await Bun.write(ref.path, content);
		return ref;
	};
}

// ----- value / error rendering -----

/**
 * Max serialized result size handed back to the model. The tool's purpose is
 * "one small value"; a buggy/over-broad program (e.g. returning an
 * un-aggregated list) must not flood the turn (Review Gate 3, P3). Programs
 * that need more should aggregate further or use a signature.
 */
const MAX_RESULT_BYTES = 16_384;

/**
 * The BEAM runtime's own default sandbox heap (peer.ex @default_max_heap
 * 6_250_000 words × 8 bytes = 50MB). Used as the per-call clamp ceiling when
 * the operator has not raised `tools.executeMaxHeapMb`.
 */
const RUNTIME_DEFAULT_HEAP_MB = 50;

/** Absolute heap ceiling regardless of settings — a typo must not exhaust the host. */
const HARD_MAX_HEAP_MB = 256;

/**
 * Resolve the sandbox heap ceiling for one execute, in BEAM words (FEAT-791).
 *
 * `settingMb` (`tools.executeMaxHeapMb`) is the OPERATOR ceiling: when >0 it
 * both raises the default for every program and bounds what a per-call
 * `requestedMb` may ask for. With the setting unset (0), a per-call request can
 * only tighten below the runtime default (~50MB) — raising the ceiling is an
 * operator decision, never a program/agent one. Everything is hard-capped at
 * 256MB so a typo cannot exhaust the host. Returns undefined when nothing
 * deviates from the runtime default (the wire frame then omits max_heap).
 *
 * ptc_runner's max_heap is in WORDS (1 word = 8 bytes); the conversion happens
 * exactly once, here.
 */
/**
 * Resolve the session-store ceiling in bytes (mirrors resolveMaxHeapWords pattern).
 *
 *  (tools.executeSessionStoreMb) is the OPERATOR ceiling: when >0 it
 * raises the default ceiling. Without a setting, the runtime default (64 MB) applies.
 * Conversion from MB to bytes happens exactly once here.
 */
export function resolveSessionStoreBytes(settingMb: number, requestedMb?: number): number | undefined {
	const operatorCeilingMb = settingMb > 0 ? settingMb : 64;
	const effectiveMb =
		requestedMb !== undefined
			? Math.min(Math.max(Math.floor(requestedMb), 1), operatorCeilingMb)
			: settingMb > 0
				? operatorCeilingMb
				: undefined;
	if (effectiveMb === undefined) return undefined;
	return Math.floor(effectiveMb * 1024 * 1024);
}

export function resolveMaxHeapWords(settingMb: number, requestedMb?: number): number | undefined {
	const operatorCeilingMb = settingMb > 0 ? Math.min(settingMb, HARD_MAX_HEAP_MB) : RUNTIME_DEFAULT_HEAP_MB;
	const effectiveMb =
		requestedMb !== undefined
			? Math.min(Math.max(Math.floor(requestedMb), 1), operatorCeilingMb)
			: settingMb > 0
				? operatorCeilingMb
				: undefined;
	if (effectiveMb === undefined) return undefined;
	return Math.floor((effectiveMb * 1024 * 1024) / 8);
}

/** The in-line truncation marker used when no artifact sink is available. */
function truncationMarker(head: string, totalBytes: number): string {
	return (
		`${head}\n\n[truncated: ${totalBytes} bytes total, showing first ${MAX_RESULT_BYTES}. ` +
		`Aggregate further in the program or use a signature to return a smaller value.]`
	);
}

/** Render an execute failure as an actionable message. */
function renderError(e: unknown): string {
	if (e instanceof PtcRuntimeError) {
		const reason = (e.data as { reason?: string } | undefined)?.reason;
		return reason ? `PtcRuntime error (${reason}): ${e.message}` : `PtcRuntime error: ${e.message}`;
	}
	return e instanceof Error ? e.message : String(e);
}

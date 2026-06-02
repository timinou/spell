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
import type { ToolSession } from "../index";
import { generateToolCatalog } from "./catalog-gen";
import { buildSessionToolProvider } from "./catalog-session";
import { type Catalog, PtcRuntimeClient, PtcRuntimeError, spawnTransport } from "./client";
import { isMapOfSignature, parseMapSignature, validateMapValue } from "./map-signature";
import { allowedTools, type CapabilityPolicy, DEFAULT_POLICY } from "./policy";
import { makeToolDispatcher, type ToolProvider } from "./tool-dispatch";

export const executeSchema = Type.Object({
	program: Type.String({ description: "PTC-Lisp program to evaluate in the sandbox." }),
	context: Type.Optional(
		Type.Record(Type.String(), Type.Any(), {
			description: "Data bound under data/<key> inside the program.",
		}),
	),
	signature: Type.Optional(Type.String({ description: "Optional PTC-Lisp return signature, e.g. '{total :int}'." })),
	timeout_ms: Type.Optional(Type.Integer({ description: "Wall-clock cap in ms (1..30000, default 1000)." })),
});

export type ExecuteParams = Static<typeof executeSchema>;

export interface ExecuteToolDetails {
	program: string;
	signature?: string;
	durationMs?: number;
}

export class ExecuteTool implements AgentTool<typeof executeSchema, ExecuteToolDetails> {
	readonly name = "execute";
	readonly label = "Execute";
	readonly description = executeDescription;
	readonly parameters = executeSchema;

	private readonly session?: ToolSession;
	private readonly policy: CapabilityPolicy;
	private readonly provider?: ToolProvider;
	private client: PtcRuntimeClient | null = null;
	private initPromise: Promise<void> | null = null;

	constructor(session?: ToolSession, opts?: { policy?: CapabilityPolicy; provider?: ToolProvider }) {
		this.session = session;
		this.policy = opts?.policy ?? DEFAULT_POLICY;
		this.provider = opts?.provider;
	}

	async execute(
		_toolCallId: string,
		params: ExecuteParams,
		signal?: AbortSignal,
		_onUpdate?: unknown,
		context?: AgentToolContext,
	): Promise<AgentToolResult> {
		const started = Date.now();
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
				// Per-execute signal: the client composes it with its own teardown
				// signal and threads it into THIS execute's tool_calls only (PLAN-324).
				signal,
			});

			if (mapOf) validateAgainstMapSignature(value, mapOf);

			return {
				content: [{ type: "text", text: renderValue(value) }],
				details: { program: params.program, signature: params.signature, durationMs: Date.now() - started },
				// The program's return value IS the payload — the whole point of execute.
				data: value,
			};
		} catch (e) {
			return {
				content: [{ type: "text", text: renderError(e) }],
				details: { program: params.program, signature: params.signature, durationMs: Date.now() - started },
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
			}),
		});

		await client.init(catalog);
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

// ----- value / error rendering -----

/**
 * Max serialized result size handed back to the model. The tool's purpose is
 * "one small value"; a buggy/over-broad program (e.g. returning an
 * un-aggregated list) must not flood the turn (Review Gate 3, P3). Programs
 * that need more should aggregate further or use a signature.
 */
const MAX_RESULT_BYTES = 16_384;

/** Render a program's return value as text for the model, capped in size. */
function renderValue(value: unknown): string {
	const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
	if (text.length <= MAX_RESULT_BYTES) return text;
	const head = text.slice(0, MAX_RESULT_BYTES);
	return (
		`${head}\n\n[truncated: ${text.length} bytes total, showing first ${MAX_RESULT_BYTES}. ` +
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

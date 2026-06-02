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

import type { AgentTool, AgentToolContext, AgentToolResult } from "@spell/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import executeDescription from "../../prompts/tools/execute.md" with { type: "text" };
import type { ToolSession } from "../index";
import { type Catalog, PtcRuntimeClient, PtcRuntimeError, spawnTransport } from "./client";
import { generateToolCatalog } from "./catalog-gen";
import { buildSessionToolProvider } from "./catalog-session";
import { type CapabilityPolicy, DEFAULT_POLICY, allowedTools } from "./policy";
import { makeToolDispatcher, type ToolProvider } from "./tool-dispatch";

export const executeSchema = Type.Object({
	program: Type.String({ description: "PTC-Lisp program to evaluate in the sandbox." }),
	context: Type.Optional(
		Type.Record(Type.String(), Type.Any(), {
			description: "Data bound under data/<key> inside the program.",
		}),
	),
	signature: Type.Optional(
		Type.String({ description: "Optional PTC-Lisp return signature, e.g. '{total :int}'." }),
	),
	timeout_ms: Type.Optional(
		Type.Integer({ description: "Wall-clock cap in ms (1..30000, default 1000)." }),
	),
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
			const client = await this.ensureClient(signal, context);
			const value = await client.execute({
				program: params.program,
				context: params.context,
				signature: params.signature,
				timeoutMs: params.timeout_ms,
			});

			return {
				content: [{ type: "text", text: renderValue(value) }],
				details: { program: params.program, signature: params.signature, durationMs: Date.now() - started },
			};
		} catch (e) {
			return {
				content: [{ type: "text", text: renderError(e) }],
				details: { program: params.program, signature: params.signature, durationMs: Date.now() - started },
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

	private async ensureClient(signal?: AbortSignal, context?: AgentToolContext): Promise<PtcRuntimeClient> {
		if (this.client) return this.client;
		// Single-flight init: concurrent executes share one spawn.
		if (!this.initPromise) this.initPromise = this.spawn(signal, context);
		await this.initPromise;
		if (!this.client) throw new Error("PtcRuntime client failed to initialize");
		return this.client;
	}

	private async spawn(signal?: AbortSignal, context?: AgentToolContext): Promise<void> {
		const provider = this.provider ?? this.defaultProvider();
		const catalogTools = generateToolCatalog(provider.catalogTools());

		// Advertise only policy-permitted tools to the runtime (pre-filter); the
		// dispatcher re-checks at call time (defense in depth).
		const permitted = new Set(allowedTools(catalogTools.map(t => t.name), this.policy));
		const catalog: Catalog = {
			tools: catalogTools.filter(t => permitted.has(t.name)),
		};

		const { transport } = spawnTransport({});
		const client = new PtcRuntimeClient({
			transport,
			onToolCall: makeToolDispatcher({
				lookup: name => (permitted.has(name) ? provider.lookup(name) : undefined),
				policy: this.policy,
				signal,
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

// ----- value / error rendering -----

/** Render a program's return value as text for the model. */
function renderValue(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value, null, 2);
}

/** Render an execute failure as an actionable message. */
function renderError(e: unknown): string {
	if (e instanceof PtcRuntimeError) {
		const reason = (e.data as { reason?: string } | undefined)?.reason;
		return reason ? `PtcRuntime error (${reason}): ${e.message}` : `PtcRuntime error: ${e.message}`;
	}
	return e instanceof Error ? e.message : String(e);
}

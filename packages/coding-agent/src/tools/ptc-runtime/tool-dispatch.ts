/**
 * Tool dispatch — the Node half of the PtcRuntime bridge.
 *
 * When a PTC-Lisp program reaches `(tool/find {...})`, the BEAM issues a
 * reentrant `tool_call` and `PtcRuntimeClient` invokes the handler this module
 * builds. The handler resolves the named Spell tool, runs its real `execute`,
 * and converts the `AgentToolResult` into a plain value the sandbox can use.
 *
 * ## Result conversion (AgentToolResult → PTC value)
 *
 * Spell tools return `{ content: (text|image)[], details?, isError? }`. A
 * PTC-Lisp program wants *data*, not display blocks, so we convert:
 *
 *   1. `isError` → throw, so the BEAM surfaces a tool error inside the sandbox
 *      (caught by ptc_runner; never crashes the runtime).
 *   2. `details` present → return it verbatim (the structured, machine-shaped
 *      result — e.g. org items, calc results). This is the richest value and
 *      what aggregation programs actually want.
 *   3. otherwise → join the text blocks into a string (mirrors today's bash
 *      idiom where tools return text the model parses).
 *
 * Images are dropped from the value (a sandbox program cannot consume them);
 * their presence is noted in a `_images` count so a program can detect them.
 *
 * ## Why a lookup function, not a tool array
 *
 * The dispatcher takes `lookupTool(name)` so it is decoupled from session
 * wiring and trivially testable. The `execute` tool (P3) supplies a lookup that
 * closes over the session's instantiated tools, minus a denylist (no recursion
 * into `execute` itself, no interactive tools).
 */

import type { AgentToolContext, AgentToolResult } from "@spell/pi-agent-core";
import type { CatalogTool } from "./catalog-gen";
import type { ToolCallHandler, ToolCallRequest } from "./client";
import { type CapabilityPolicy, DEFAULT_POLICY, enforcePolicy } from "./policy";

/** Minimal shape of a runnable tool (structural subset of AgentTool). */
export interface DispatchableTool {
	name: string;
	execute(
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		onUpdate?: unknown,
		context?: AgentToolContext,
	): Promise<AgentToolResult>;
}

/** Resolve a tool by name, or `undefined` if absent/denied. */
export type ToolLookup = (name: string) => DispatchableTool | undefined;

/**
 * Supplies the catalog + lookup the `execute` tool needs. Defined here (a
 * neutral module) so `execute.ts` and `catalog-session.ts` share one type
 * without an import cycle.
 */
export interface ToolProvider {
	/** Catalog entries (name + parameters) for signature/effect generation. */
	catalogTools(): CatalogTool[];
	/** Resolve a runnable tool instance by name. */
	lookup(name: string): DispatchableTool | undefined;
}

export interface DispatchOptions {
	lookup: ToolLookup;
	/** Capability policy enforced before each tool runs (default: read+write). */
	policy?: CapabilityPolicy;
	/**
	 * Dispatch-level abort signal, composed with the per-call signal the client
	 * supplies for each tool_call. Use for a whole-dispatcher kill switch; the
	 * per-execute signal (passed to the returned handler) is the precise one
	 * (PLAN-324).
	 */
	signal?: AbortSignal;
	/** Context threaded into every tool execute. */
	context?: AgentToolContext;
	/** Monotonic id source for toolCallId; defaults to a local counter. */
	idPrefix?: string;
}

/** Raised when a requested tool is not available to programs. */
export class ToolNotAvailableError extends Error {
	constructor(name: string) {
		super(`tool '${name}' is not available to PtcRuntime programs`);
		this.name = "ToolNotAvailableError";
	}
}

/**
 * Build the `onToolCall` handler the PtcRuntimeClient invokes for each reentrant
 * tool_call. Each call resolves the tool, runs it, and returns a PTC value.
 */
export function makeToolDispatcher(opts: DispatchOptions): ToolCallHandler {
	let seq = 0;
	const prefix = opts.idPrefix ?? "ptc";
	const policy = opts.policy ?? DEFAULT_POLICY;

	return async ({ tool, args }: ToolCallRequest, signal?: AbortSignal): Promise<unknown> => {
		const instance = opts.lookup(tool);
		if (!instance) throw new ToolNotAvailableError(tool);

		// Enforce the capability policy BEFORE running the tool. A denied effect
		// throws PolicyDeniedError, surfaced to the program as a tool error.
		enforcePolicy(tool, policy);

		// Compose the per-call signal (the originating execute's, supplied by the
		// client) with any dispatch-level signal, so the tool aborts when EITHER
		// fires — without one execute's cancellation reaching another (PLAN-324).
		const effective = opts.signal && signal ? AbortSignal.any([opts.signal, signal]) : (signal ?? opts.signal);

		const toolCallId = `${prefix}-${tool}-${seq++}`;
		const result = await instance.execute(toolCallId, args, effective, undefined, opts.context);
		return resultToValue(result);
	};
}

/**
 * Convert an `AgentToolResult` into a value a PTC-Lisp program can consume.
 * Exported for direct testing.
 */
export function resultToValue(result: AgentToolResult): unknown {
	if (result.isError) {
		throw new Error(textOf(result) || "tool returned an error");
	}

	// Structured details are the richest machine-shaped value when present.
	if (result.details !== undefined && result.details !== null) {
		return result.details;
	}

	const text = textOf(result);
	const imageCount = (result.content ?? []).filter(c => c.type === "image").length;

	// If the result is *only* images, hand back a marker the program can branch
	// on rather than an empty string.
	if (text === "" && imageCount > 0) {
		return { _images: imageCount };
	}

	return text;
}

/** Concatenate all text blocks of a result. */
function textOf(result: AgentToolResult): string {
	return (result.content ?? [])
		.filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
		.map(c => c.text)
		.join("");
}

/**
 * Build a denylist-aware lookup from a map of instantiated tools.
 *
 * `denied` names (e.g. `execute`, `ask`, `exit_plan_mode`) are never resolvable
 * from inside a program — preventing recursion and interactive deadlocks. The
 * capability-policy gate (P3) layers effect-based filtering on top of this.
 */
export function lookupFromMap(
	tools: Map<string, DispatchableTool>,
	denied: ReadonlySet<string> = DEFAULT_DENYLIST,
): ToolLookup {
	return (name: string) => (denied.has(name) ? undefined : tools.get(name));
}

/**
 * Tools that must never be callable from inside a PTC-Lisp program.
 *
 * This is a STRUCTURAL guarantee (Review Gate 3, P2): these tools are denied
 * regardless of effect tag or policy, because they re-enter the agent loop,
 * block on humans, mutate session state, or could self-escalate. Do NOT rely on
 * the `effectOf` exec-default to keep them out — a future maintainer tagging one
 * `read`/`write` would otherwise make it instantly program-callable. Denylisting
 * here makes the guarantee independent of the policy.
 */
export const DEFAULT_DENYLIST: ReadonlySet<string> = new Set([
	// recursion / completion / interactive
	"execute", // no recursion into the coprocessor
	"task", // spawns subagents that could transitively re-enter execute (PLAN-323)
	"ask", // interactive — would deadlock the sandbox
	"exit_plan_mode", // mutates agent mode
	"resolve", // deferred-action resolution is an agent-loop concern
	"submit_result", // completion signal, not a data tool
	// agent-state / escalation — structurally off-limits to programs
	"approvals", // could self-grant a capability
	"checkpoint", // mutates session history
	"rewind", // rewrites session history
	"cancel_job", // cancels sibling work
	"await", // blocks on async jobs (sync point)
	"goals", // out-of-process goal scheduling
	"canvas", // UI surface
	"canvas_cast", // UI surface
]);

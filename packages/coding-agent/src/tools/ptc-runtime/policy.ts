/**
 * Capability policy — the effect gate for PtcRuntime programs.
 *
 * A program reaches tools via the bridge (tool-dispatch.ts). Before a tool runs,
 * its effect tag (effects.ts) is checked against the session's policy: an
 * allowlist of permitted effects. A denied effect throws `PolicyDeniedError`,
 * which the bridge surfaces to the program as a tool error (caught by the
 * sandbox; the runtime is unaffected).
 *
 * ## Set semantics (NOT a ladder)
 *
 * The policy is a flat SET of allowed effects (see effects.ts for why). The V1
 * default is `{pure, read, write}` — programs may read and mutate repo/project
 * state, but may NOT `exec` (bash/task) or reach the `network`. This matches the
 * user's "read and write" decision while keeping the two highest-blast-radius
 * effects off by default.
 *
 * ## Extension points (see specs/beam-orchestrator/05-fup-...)
 *
 * The policy is a value, not hardcoded, so future work can:
 *   - widen/narrow per session (settings, env, or an explicit tool param),
 *   - route `exec`/`network` through the existing approvals tool for
 *     human-in-the-loop grants,
 *   - refine per-argument (e.g. allow `org` query but deny `org` set) once
 *     tools expose sub-command effects.
 *
 * V1 keeps it a single immutable default with these seams documented.
 */

import { type EffectTag, effectOf } from "./effects";

/** A capability policy: the set of effects a program may invoke. */
export interface CapabilityPolicy {
	/** Human-readable name (for diagnostics). */
	readonly name: string;
	/** The allowlist of permitted effects. */
	readonly allowed: ReadonlySet<EffectTag>;
}

/** The V1 default: read + write, no exec, no network. */
export const DEFAULT_POLICY: CapabilityPolicy = {
	name: "read-write",
	allowed: new Set<EffectTag>(["pure", "read", "write"]),
};

/** A permissive policy allowing every effect (opt-in, e.g. trusted contexts). */
export const PERMISSIVE_POLICY: CapabilityPolicy = {
	name: "all",
	allowed: new Set<EffectTag>(["pure", "read", "write", "exec", "network"]),
};

/** A read-only policy (no mutation, exec, or network). */
export const READONLY_POLICY: CapabilityPolicy = {
	name: "read-only",
	allowed: new Set<EffectTag>(["pure", "read"]),
};

/** Raised when a tool's effect is not permitted by the active policy. */
export class PolicyDeniedError extends Error {
	readonly tool: string;
	readonly effect: EffectTag;
	readonly policy: string;
	constructor(tool: string, effect: EffectTag, policy: string) {
		super(
			`tool '${tool}' (effect: ${effect}) is denied by the '${policy}' policy. ` +
				`Allowed effects do not include '${effect}'.`,
		);
		this.name = "PolicyDeniedError";
		this.tool = tool;
		this.effect = effect;
		this.policy = policy;
	}
}

/**
 * Check whether a tool is permitted under a policy. Returns the resolved effect
 * (for logging) or throws `PolicyDeniedError`.
 */
export function enforcePolicy(toolName: string, policy: CapabilityPolicy, args?: Record<string, unknown>): EffectTag {
	// Pass args so sub-command effects resolve per-call (e.g. `org query` → read
	// even though `org` is statically tagged `write`).
	const effect = effectOf(toolName, args);
	if (!policy.allowed.has(effect)) {
		throw new PolicyDeniedError(toolName, effect, policy.name);
	}
	return effect;
}

/** True if a tool is permitted (non-throwing companion to enforcePolicy). */
export function isAllowed(toolName: string, policy: CapabilityPolicy): boolean {
	return policy.allowed.has(effectOf(toolName));
}

/** The set of tool names (from a catalog) a policy permits — for the init payload. */
export function allowedTools(toolNames: string[], policy: CapabilityPolicy): string[] {
	return toolNames.filter(n => isAllowed(n, policy));
}

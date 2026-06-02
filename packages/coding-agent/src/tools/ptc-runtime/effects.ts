/**
 * Capability/effect taxonomy for PtcRuntime programs.
 *
 * Every Spell tool a program can reach is tagged with an effect. The
 * capability-policy gate (see `policy.ts`, P3) decides which effects a program
 * may invoke; the catalog generator (`catalog-gen.ts`) embeds the tag so the
 * BEAM-side runtime and the Node-side gate agree on one taxonomy.
 *
 * ## The five effects (ascending privilege)
 *
 *   | effect    | meaning                                   | example tools          |
 *   |-----------|-------------------------------------------|------------------------|
 *   | `pure`    | deterministic compute, no I/O             | calc                   |
 *   | `read`    | reads repo / project state, no mutation   | find, get, org(query)  |
 *   | `write`   | mutates repo / project state              | edit, create, org(set) |
 *   | `exec`    | runs arbitrary external processes/agents  | bash, task             |
 *   | `network` | reaches the network                       | fetch, web_search      |
 *
 * ## Why a static table, not tool self-declaration
 *
 * Tools don't currently declare an effect. Centralizing the mapping here makes
 * the policy surface auditable in one place and forces a deliberate decision
 * for every new tool (the `effectOf` default is the most-restrictive unknown →
 * `exec`, so an untagged tool is denied unless the policy explicitly allows
 * `exec`). When tools eventually self-declare (an `effect` field on AgentTool),
 * this table becomes the fallback and the FUP (05-...) documents the migration.
 *
 * ## Sub-command nuance (documented, not yet enforced)
 *
 * Some tools span effects by sub-command: `org` is `read` for `query`/`get` but
 * `write` for `update`/`set`/`create`. V1 tags the tool at its HIGHEST effect
 * (so `org` → `write`) — conservative. Per-argument effect refinement is a
 * documented extension point in the FUP.
 */

export type EffectTag = "pure" | "read" | "write" | "exec" | "network";

/** All effect tags, for enumeration (NOT a privilege ordering — see below). */
export const ALL_EFFECTS: readonly EffectTag[] = ["pure", "read", "write", "exec", "network"];

/**
 * Effects are a FLAT SET, not a privilege ladder (Review Gate 2, P2).
 *
 * A policy is an allowlist of effects; the gate checks set membership
 * (`effectAllowed`). There is deliberately NO ordering: `exec` and `network`
 * are NOT "more than" `write`, and you cannot grant a ceiling that implies the
 * ones below it. This matters because the default V1 policy is `{pure, read,
 * write}` — which must allow writes while denying `exec` and `network`. On a
 * ladder (`write < exec < network`) you could not express that; as a set you
 * simply omit `exec`/`network`. The P3 gate MUST use set membership.
 *
 * `pure` is implicitly always allowed (a pure program touches no tool effect),
 * but it appears in the set for completeness.
 */

/**
 * The canonical tool→effect table. The KEY is the tool's registered name.
 *
 * Conservative by construction: a tool spanning effects is tagged at its
 * highest (most-privileged) effect. Unknown tools default to `exec` via
 * `effectOf` (deny-by-default under a read+write policy).
 */
export const TOOL_EFFECTS: Readonly<Record<string, EffectTag>> = {
	// pure compute
	calc: "pure",

	// read-only repo / project state
	find: "read",
	get: "read",
	status: "read",
	memory: "write", // search/about/neighbors are read; note/save/link WRITE → tag at max
	resolve: "read",

	// write — mutate repo / project / org state
	edit: "write",
	create: "write",
	org: "write", // query/get are read; update/set/create are write → tag at max
	todo_write: "write",

	// exec — external processes / agent spawning
	bash: "exec",
	task: "exec",
	ssh: "exec",

	// network
	fetch: "network",
	web_search: "network",
};

/**
 * Resolve a tool's effect. Unknown tools default to `exec` — the deny-by-default
 * posture: an untagged tool is treated as maximally privileged so it is blocked
 * under anything short of an exec-allowing policy. (Tags below `exec` such as
 * `network` are orthogonal; `exec` is chosen as the safe default because it is
 * the boundary the default read+write policy denies.)
 */
export function effectOf(toolName: string, args?: Record<string, unknown>): EffectTag {
	const base = TOOL_EFFECTS[toolName] ?? "exec";
	// Sub-command refinement: a tool tagged at its HIGHEST effect (conservative
	// default) can resolve to a LOWER effect for a read-only sub-command, so a
	// read-only policy admits `org query` while still denying `org set`. Refinement
	// only ever RELAXES from the static max — it can never escalate above it.
	if (args) {
		const refined = refineEffect(toolName, args);
		if (refined) return refined;
	}
	return base;
}

/**
 * Sub-command effect resolver: tools whose effect depends on an argument.
 * Returns a refined (lower) effect for a known read-only sub-command, or null to
 * fall back to the static (highest) tag. Only READ-side sub-commands are listed
 * — anything unlisted keeps the conservative max, so refinement is never an
 * accidental escalation.
 */
function refineEffect(toolName: string, args: Record<string, unknown>): EffectTag | null {
	switch (toolName) {
		case "org": {
			const cmd = typeof args.command === "string" ? args.command : undefined;
			return cmd && ORG_READ_COMMANDS.has(cmd) ? "read" : null;
		}
		case "memory": {
			const action = typeof args.action === "string" ? args.action : undefined;
			return action && MEMORY_READ_ACTIONS.has(action) ? "read" : null;
		}
		default:
			return null;
	}
}

/** `org` sub-commands that only READ project state. */
const ORG_READ_COMMANDS: ReadonlySet<string> = new Set([
	"query",
	"get",
	"dashboard",
	"wave",
	"graph",
	"validate",
	"validate-plan",
]);

/** `memory` actions that only READ the knowledge graph. */
const MEMORY_READ_ACTIONS: ReadonlySet<string> = new Set(["search", "about", "neighbors", "since"]);

/** True if `effect` is permitted by an allowlist of effects. */
export function effectAllowed(effect: EffectTag, allowed: ReadonlySet<EffectTag>): boolean {
	return allowed.has(effect);
}

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

/** Privilege order — index = ascending privilege. */
export const EFFECT_ORDER: readonly EffectTag[] = ["pure", "read", "write", "exec", "network"];

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
	memory: "read", // search/about/neighbors; note/save are write — see nuance below
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
export function effectOf(toolName: string): EffectTag {
	return TOOL_EFFECTS[toolName] ?? "exec";
}

/** True if `effect` is permitted by an allowlist of effects. */
export function effectAllowed(effect: EffectTag, allowed: ReadonlySet<EffectTag>): boolean {
	return allowed.has(effect);
}

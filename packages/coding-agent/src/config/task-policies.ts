/**
 * Per-project task policy system.
 *
 * Policies associate layer-based gates and guidance with org items. Projects
 * declare their layer vocabulary in `spell.kdl` (preferred) or `.spell/task-policies.kdl`;
 * modes can override or extend via frontmatter
 * `taskPolicies`. Gates are auto-injected whenever a task is created with a
 * matching `layer` value.
 */

import { isEnoent, logger } from "@spell/pi-utils";
import { loadSpellKdl } from "./spell-kdl";
import { parseTaskPoliciesKdl } from "./task-policies-kdl";

// Types
// =============================================================================

export interface LayerDefinition {
	description: string;
}

export interface TaskPolicyMatch {
	layer: string;
}

/**
 * Verification gates a policy applies to a layer. Shares the `verify{}`
 * vocabulary with {@link TodoNode}: `commit|artifact|cmd` gate completion,
 * `review` is advisory. (The legacy `gate*`/`verifyCmd` names were folded into
 * this shape in PLAN-328; `verify-cmd` advisory commands now map to `cmd`.)
 */
export interface TaskVerify {
	commit?: boolean;
	artifact?: string;
	cmd?: string;
	review?: string;
}

/** @deprecated Alias retained for readability at call sites; identical to {@link TaskVerify}. */
export type TaskPolicyGates = TaskVerify;

export interface TaskPolicy {
	name: string;
	description?: string;
	match: TaskPolicyMatch;
	verify: TaskVerify;
	inject?: string;
}

export interface TaskPolicyConfig {
	version: number;
	layers: Record<string, LayerDefinition>;
	policies: TaskPolicy[];
}

// Loading
// =============================================================================

/**
 * Load task policies from the project root.
 *
 * Resolution order:
 * 1. `spell.kdl` at project root (unified config)
 * 2. `.spell/task-policies.kdl` (standalone KDL)
 *
 * First file found wins. No merging across formats.
 */
export async function loadTaskPolicies(projectDir: string): Promise<TaskPolicyConfig | undefined> {
	// 1. Try spell.kdl (unified project config)
	const spellConfig = await loadSpellKdl(projectDir);
	if (spellConfig) return spellConfig.policies;

	// 2. Try .spell/task-policies.kdl
	const kdlPath = `${projectDir}/.spell/task-policies.kdl`;
	try {
		const kdlContent = await Bun.file(kdlPath).text();
		return parseTaskPoliciesKdl(kdlContent);
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("task-policies: failed to load KDL", {
				filePath: kdlPath,
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	}

	return undefined;
}

// Matching
// =============================================================================

/** Return all policies whose `match.layer` equals the given layer. */
export function matchPolicies(layer: string | undefined, policies: TaskPolicy[]): TaskPolicy[] {
	if (!layer) return [];
	return policies.filter(p => p.match.layer === layer);
}

// Merging
// =============================================================================

const EMPTY_CONFIG: TaskPolicyConfig = { version: 1, layers: {}, policies: [] };

/**
 * Merge project-level and mode-level policies.
 * Mode policies override project policies by name. Mode layers override
 * project layers on conflict.
 */
export function mergePolicies(
	project: TaskPolicyConfig | undefined,
	modePolicies: TaskPolicy[] | undefined,
	modeLayers?: Record<string, LayerDefinition>,
): TaskPolicyConfig {
	const base = project ?? EMPTY_CONFIG;
	if (!modePolicies?.length && !modeLayers) return base;

	// Merge layers: mode wins on conflict
	const layers = { ...base.layers, ...modeLayers };

	// Merge policies: mode overrides by name
	if (!modePolicies?.length) return { ...base, layers };

	const modeNames = new Set(modePolicies.map(p => p.name));
	const kept = base.policies.filter(p => !modeNames.has(p.name));
	return { version: base.version, layers, policies: [...kept, ...modePolicies] };
}

// Gate Resolution
// =============================================================================

/** Compute merged gates from all policies matching the given layer. */
/** Compute merged verify gates from all policies matching the given layer. */
export function resolveGates(layer: string | undefined, policies: TaskPolicy[]): TaskVerify {
	const matching = matchPolicies(layer, policies);
	const merged: TaskVerify = {};
	for (const policy of matching) {
		if (policy.verify.commit !== undefined) merged.commit = policy.verify.commit;
		if (policy.verify.artifact !== undefined) merged.artifact = policy.verify.artifact;
		if (policy.verify.cmd !== undefined) merged.cmd = policy.verify.cmd;
		if (policy.verify.review !== undefined) merged.review = policy.verify.review;
	}
	return merged;
}

/** Resolve inject text from all policies matching the given layer. */
export function resolveInjectText(layer: string | undefined, policies: TaskPolicy[]): string | undefined {
	const matching = matchPolicies(layer, policies);
	const texts = matching.map(p => p.inject).filter((t): t is string => !!t?.trim());
	return texts.length > 0 ? texts.join("\n") : undefined;
}

/**
 * Apply policy gates to a task, respecting existing explicit gates.
 * Existing gates are never overwritten — policy gates fill in missing fields.
 */
/**
 * Apply policy verify gates to a node, respecting existing explicit gates.
 * Existing fields are never overwritten — policy gates fill in missing ones.
 */
export function applyPolicyGates(
	existingVerify: TaskVerify,
	layer: string | undefined,
	policies: TaskPolicy[],
): TaskVerify {
	const policyVerify = resolveGates(layer, policies);
	return {
		commit: existingVerify.commit ?? policyVerify.commit,
		artifact: existingVerify.artifact ?? policyVerify.artifact,
		cmd: existingVerify.cmd ?? policyVerify.cmd,
		review: existingVerify.review ?? policyVerify.review,
	};
}

// Layer Resolution
// =============================================================================

/**
 * Resolve a layer from an org item ID.
 *
 * For sub-outline items (`FEAT-001::implement-ui`), checks the sub-outline's
 * own LAYER first, then falls back to the parent item's LAYER.
 * For top-level items, returns their LAYER directly.
 */
export function resolveLayerFromProperties(
	orgItemId: string | undefined,
	lookupFn: (id: string) => Record<string, string> | undefined,
): string | undefined {
	if (!orgItemId) return undefined;

	const props = lookupFn(orgItemId);
	if (props?.LAYER) return props.LAYER;

	// For sub-outline items, derive parent ID and check parent's LAYER
	const separatorIndex = orgItemId.indexOf("::");
	if (separatorIndex === -1) return undefined;

	const parentId = orgItemId.slice(0, separatorIndex);
	const parentProps = lookupFn(parentId);
	return parentProps?.LAYER;
}

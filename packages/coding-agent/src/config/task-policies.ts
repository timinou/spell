/**
 * Per-project task policy system.
 *
 * Policies associate layer-based gates and guidance with org items. Projects
 * declare their layer vocabulary in `spell.kdl` (preferred) or `.spell/task-policies.kdl`;
 * modes can override or extend via frontmatter
 * `taskPolicies`. Gates are auto-injected whenever a task is created with a
 * matching `layer` value.
 */

import { isEnoent, logger } from "@oh-my-pi/pi-utils";
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

export interface TaskPolicyGates {
	gateCommit?: boolean;
	gateArtifact?: string;
	gateCmd?: string;
	gateLlm?: string;
	verifyCmd?: string;
}

export interface TaskPolicy {
	name: string;
	description?: string;
	match: TaskPolicyMatch;
	gates: TaskPolicyGates;
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
export function resolveGates(layer: string | undefined, policies: TaskPolicy[]): TaskPolicyGates {
	const matching = matchPolicies(layer, policies);
	const merged: TaskPolicyGates = {};
	for (const policy of matching) {
		if (policy.gates.gateCommit !== undefined) merged.gateCommit = policy.gates.gateCommit;
		if (policy.gates.gateArtifact !== undefined) merged.gateArtifact = policy.gates.gateArtifact;
		if (policy.gates.gateCmd !== undefined) merged.gateCmd = policy.gates.gateCmd;
		if (policy.gates.gateLlm !== undefined) merged.gateLlm = policy.gates.gateLlm;
		if (policy.gates.verifyCmd !== undefined) merged.verifyCmd = policy.gates.verifyCmd;
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
export function applyPolicyGates(
	existingGates: TaskPolicyGates,
	layer: string | undefined,
	policies: TaskPolicy[],
): TaskPolicyGates {
	const policyGates = resolveGates(layer, policies);
	return {
		gateCommit: existingGates.gateCommit ?? policyGates.gateCommit,
		gateArtifact: existingGates.gateArtifact ?? policyGates.gateArtifact,
		gateCmd: existingGates.gateCmd ?? policyGates.gateCmd,
		gateLlm: existingGates.gateLlm ?? policyGates.gateLlm,
		verifyCmd: existingGates.verifyCmd ?? policyGates.verifyCmd,
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

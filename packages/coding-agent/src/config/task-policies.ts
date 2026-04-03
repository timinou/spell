/**
 * Per-project task policy system.
 *
 * Policies associate layer-based gates and guidance with org items. Projects
 * declare their layer vocabulary in `.spell/task-policies.yml`; modes can
 * override or extend via frontmatter `taskPolicies`. Gates are auto-injected
 * whenever a task is created with a matching `layer` value.
 */

import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

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

// Parsing + Validation
// =============================================================================

interface RawPolicy {
	name?: unknown;
	description?: unknown;
	match?: { layer?: unknown };
	gates?: Record<string, unknown>;
	inject?: unknown;
}

interface RawConfig {
	version?: unknown;
	layers?: Record<string, { description?: unknown }>;
	policies?: RawPolicy[];
}

/**
 * Parse and validate a task-policies YAML string.
 * Returns undefined on parse failure or missing version field.
 */
export function parseTaskPolicies(yamlContent: string): TaskPolicyConfig | undefined {
	let raw: RawConfig;
	try {
		raw = YAML.parse(yamlContent) as RawConfig;
	} catch (error) {
		logger.warn("task-policies: YAML parse error", { error: error instanceof Error ? error.message : String(error) });
		return undefined;
	}
	if (!raw || typeof raw !== "object") return undefined;

	if (raw.version === undefined || raw.version === null) {
		logger.warn("task-policies: missing 'version' field");
		return undefined;
	}

	const version = Number(raw.version);
	if (!Number.isFinite(version)) {
		logger.warn("task-policies: invalid version", { version: raw.version });
		return undefined;
	}

	const layers: Record<string, LayerDefinition> = {};
	if (raw.layers && typeof raw.layers === "object") {
		for (const [name, def] of Object.entries(raw.layers)) {
			layers[name] = { description: typeof def?.description === "string" ? def.description : "" };
		}
	}

	const policies: TaskPolicy[] = [];
	if (Array.isArray(raw.policies)) {
		for (const rawPolicy of raw.policies) {
			if (!rawPolicy || typeof rawPolicy !== "object") continue;
			if (typeof rawPolicy.name !== "string" || !rawPolicy.name) {
				logger.warn("task-policies: skipping policy without name");
				continue;
			}
			if (!rawPolicy.match || typeof rawPolicy.match !== "object" || typeof rawPolicy.match.layer !== "string") {
				logger.warn("task-policies: skipping policy without valid match.layer", { name: rawPolicy.name });
				continue;
			}
			const gates: TaskPolicyGates = {};
			if (rawPolicy.gates && typeof rawPolicy.gates === "object") {
				if (typeof rawPolicy.gates.gateCommit === "boolean") gates.gateCommit = rawPolicy.gates.gateCommit;
				if (typeof rawPolicy.gates.gateArtifact === "string") gates.gateArtifact = rawPolicy.gates.gateArtifact;
				if (typeof rawPolicy.gates.gateCmd === "string") gates.gateCmd = rawPolicy.gates.gateCmd;
				if (typeof rawPolicy.gates.gateLlm === "string") gates.gateLlm = rawPolicy.gates.gateLlm;
				if (typeof rawPolicy.gates.verifyCmd === "string") gates.verifyCmd = rawPolicy.gates.verifyCmd;
			}
			policies.push({
				name: rawPolicy.name,
				description: typeof rawPolicy.description === "string" ? rawPolicy.description : undefined,
				match: { layer: rawPolicy.match.layer },
				gates,
				inject: typeof rawPolicy.inject === "string" ? rawPolicy.inject : undefined,
			});
		}
	}

	return { version, layers, policies };
}

/**
 * Load task policies from `.spell/task-policies.yml` in the project root.
 * Returns undefined if the file does not exist or fails to parse.
 */
export async function loadTaskPolicies(projectDir: string): Promise<TaskPolicyConfig | undefined> {
	const filePath = `${projectDir}/.spell/task-policies.yml`;
	try {
		const content = await Bun.file(filePath).text();
		return parseTaskPolicies(content);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		logger.warn("task-policies: failed to load", {
			filePath,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
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

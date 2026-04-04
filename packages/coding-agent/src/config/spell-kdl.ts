/**
 * Unified spell.kdl project configuration parser.
 *
 * spell.kdl is the single entry point for project config. It supports:
 * - `domain "coding"` — set the active domain
 * - `import "spell.coding.typescript"` — pull in built-in template
 * - `layer` / `policy` nodes — same format as task-policies.kdl
 *
 * Import resolution merges template layers/policies as a base;
 * local declarations override by name (layers by key, policies by name).
 */

import type { Node } from "@bgotink/kdl";
import { Document, format, parse } from "@bgotink/kdl";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";

import { resolveTemplate } from "../templates";
import type { TaskPolicyConfig } from "./task-policies";
import { getStringArgument, parseTaskPoliciesKdl } from "./task-policies-kdl";

export interface SpellProjectConfig {
	domain?: string;
	policies: TaskPolicyConfig;
}

/**
 * Parse a spell.kdl content string into a SpellProjectConfig.
 *
 * Resolves `import` references against built-in templates and merges
 * them in order. Local layer/policy nodes override imported ones.
 */
export function parseSpellKdl(content: string): SpellProjectConfig | undefined {
	let document: Document;
	try {
		document = parse(content);
	} catch (error) {
		logger.warn("spell-kdl: parse error", {
			error: error instanceof Error ? error.message : String(error),
		});
		return {
			domain: undefined,
			policies: { version: 1, layers: {}, policies: [] },
		};
	}

	let domain: string | undefined;
	const importNamespaces: string[] = [];

	// Collect domain and import nodes; build a KDL subset of layer/policy nodes
	// by filtering them from the original document for reuse with parseTaskPoliciesKdl.
	const layerPolicyNodes: Node[] = [];

	for (const node of document.nodes) {
		switch (node.getName()) {
			case "domain":
				domain = getStringArgument(node);
				break;
			case "import":
				{
					const ns = getStringArgument(node);
					if (ns) importNamespaces.push(ns);
				}
				break;
			case "layer":
			case "policy":
				layerPolicyNodes.push(node);
				break;
		}
	}

	// Resolve imports: each template provides base layers/policies
	let mergedLayers: Record<string, { description: string }> = {};
	let mergedPolicies: TaskPolicyConfig["policies"] = [];

	for (const ns of importNamespaces) {
		const templateContent = resolveTemplate(ns);
		if (!templateContent) {
			logger.warn("spell-kdl: unknown import namespace, skipping", { namespace: ns });
			continue;
		}
		const templateConfig = parseTaskPoliciesKdl(templateContent);
		if (!templateConfig) {
			logger.warn("spell-kdl: failed to parse template", { namespace: ns });
			continue;
		}
		// Accumulate: later imports override earlier ones by key/name
		mergedLayers = { ...mergedLayers, ...templateConfig.layers };
		const templateNames = new Set(templateConfig.policies.map(p => p.name));
		mergedPolicies = [...mergedPolicies.filter(p => !templateNames.has(p.name)), ...templateConfig.policies];
	}

	// Parse local layer/policy nodes by reconstructing a minimal KDL string
	// that parseTaskPoliciesKdl can handle.
	if (layerPolicyNodes.length > 0) {
		// Serialize the subset back to KDL text for parsing
		const subsetDoc = new Document([...layerPolicyNodes]);
		const localContent = format(subsetDoc);
		const localConfig = parseTaskPoliciesKdl(localContent);
		if (localConfig) {
			// Local layers override imported layers by key
			mergedLayers = { ...mergedLayers, ...localConfig.layers };
			// Local policies override imported policies by name
			const localNames = new Set(localConfig.policies.map(p => p.name));
			mergedPolicies = [...mergedPolicies.filter(p => !localNames.has(p.name)), ...localConfig.policies];
		}
	}

	return {
		domain,
		policies: {
			version: 1,
			layers: mergedLayers,
			policies: mergedPolicies,
		},
	};
}

/**
 * Load and parse spell.kdl from a project directory.
 *
 * Returns undefined if the file doesn't exist or an I/O error occurs.
 * Returns an empty config (with warning logged) if the file exists but has invalid KDL.
 */
export async function loadSpellKdl(projectDir: string): Promise<SpellProjectConfig | undefined> {
	const spellKdlPath = `${projectDir}/spell.kdl`;
	try {
		const content = await Bun.file(spellKdlPath).text();
		return parseSpellKdl(content);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		logger.warn("spell-kdl: failed to load spell.kdl", {
			filePath: spellKdlPath,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

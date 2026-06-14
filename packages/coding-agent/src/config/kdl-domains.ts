/**
 * Inline KDL domain definitions — the declarative constructor for `SpellDomain`.
 *
 * A `domain "x" { … }` block (as opposed to the bare selector `domain "x"`)
 * fully defines a declarative domain in data: prompt, tool policy, surface,
 * knowledge lane, env contract, model roles. Behavioral domains (panels,
 * workspaces, custom tooling) still live in `domain/<name>/manifest.ts`; both
 * build the same `SpellDomain` shape.
 *
 * Inheritance: `domain "harbor" { extends "autonomous"; … }` reuses the mode
 * `extends` mechanism. Resolution merges parent→child with field-kind-aware
 * semantics (see `mergeDomainDefs`).
 *
 * Selector vs definition: a `domain` node with NO children block is the
 * project's domain *selector* (handled in spell-kdl.ts / detection.ts and left
 * untouched here). Only nodes WITH a children block are parsed as definitions.
 */

import type { Document, Node } from "@bgotink/kdl";
import type { DomainEnvConfig, DomainKnowledgeConfig, DomainToolConfig, SpellDomain } from "../../../../domain/growth/src/types";
import {
	getBooleanArgument,
	getChildNode,
	getChildNodes,
	getNumberArgument,
	getStringArgument,
	getStringArguments,
	getStringProperty,
} from "./kdl-helpers";

/**
 * A partial `SpellDomain` parsed from one KDL `domain { … }` block, before
 * `extends` resolution. `extends` names a parent domain (KDL def or builtin).
 * `toolsAllow`/`toolsDeny` are kept as raw lists (not yet folded into the
 * `DomainToolConfig` include/exclude) so the merge can apply the
 * allow-subtracts-deny rule across the inheritance chain.
 */
export interface ParsedDomainBlock {
	name: string;
	extends?: string;
	description?: string;
	systemPrompt?: string;
	systemPromptPath?: string;
	contextFiles?: string[];
	interactiveSurface?: "tui" | "qml" | "none";
	knowledge?: DomainKnowledgeConfig;
	env?: DomainEnvConfig;
	modelRoles?: Record<string, string>;
	toolsAllow?: string[];
	toolsDeny?: string[];
}

/** True when a `domain` node carries a children block (⇒ inline definition). */
export function isDomainDefinition(node: Node): boolean {
	return node.getName() === "domain" && (node.children?.nodes.length ?? 0) > 0;
}

function parseKnowledge(node: Node): DomainKnowledgeConfig | undefined {
	const config: DomainKnowledgeConfig = {};
	const embeddingsNode = getChildNode(node, "embeddings");
	if (embeddingsNode) {
		const embeddings = getBooleanArgument(embeddingsNode);
		if (embeddings !== undefined) config.embeddings = embeddings;
	}
	const recencyNode = getChildNode(node, "embed-recency-days");
	if (recencyNode) {
		const days = getNumberArgument(recencyNode);
		if (days !== undefined && days > 0) config.embedRecencyDays = days;
	}
	return Object.keys(config).length > 0 ? config : undefined;
}

function parseEnv(node: Node): DomainEnvConfig | undefined {
	const requireNode = getChildNode(node, "require");
	const require = requireNode ? getStringArguments(requireNode) : [];
	const set: Record<string, string> = {};
	// `set "NAME" "value"` per node, repeatable.
	for (const child of getChildNodes(node, "set")) {
		const name = getStringArgument(child, 0);
		const value = getStringArgument(child, 1);
		if (name && value !== undefined) set[name] = value;
	}
	const env: DomainEnvConfig = {};
	if (require.length > 0) env.require = require;
	if (Object.keys(set).length > 0) env.set = set;
	return Object.keys(env).length > 0 ? env : undefined;
}

function parseModelRoles(node: Node): Record<string, string> | undefined {
	const modelNode = getChildNode(node, "model");
	if (!modelNode) return undefined;
	const rolesNode = getChildNode(modelNode, "roles");
	if (!rolesNode) return undefined;
	const roles: Record<string, string> = {};
	for (const child of getChildNodes(rolesNode)) {
		const role = child.getName();
		const value = getStringArgument(child);
		if (role && value !== undefined) roles[role] = value;
	}
	return Object.keys(roles).length > 0 ? roles : undefined;
}

/** Parse a single `domain "x" { … }` definition block. */
export function parseDomainNode(node: Node): ParsedDomainBlock | undefined {
	const name = getStringArgument(node);
	if (!name) return undefined;

	const block: ParsedDomainBlock = { name };

	const extendsValue = getStringProperty(node, "extends");
	if (extendsValue !== undefined) block.extends = extendsValue;

	const descriptionNode = getChildNode(node, "description");
	const description = descriptionNode ? getStringArgument(descriptionNode) : undefined;
	if (description !== undefined) block.description = description;

	const surfaceNode = getChildNode(node, "surface");
	const surface = surfaceNode ? getStringArgument(surfaceNode) : undefined;
	if (surface === "tui" || surface === "qml" || surface === "none") {
		block.interactiveSurface = surface;
	}

	const promptNode = getChildNode(node, "prompt");
	const prompt = promptNode ? getStringArgument(promptNode) : undefined;
	if (prompt !== undefined) block.systemPrompt = prompt.trimEnd();

	const promptPathNode = getChildNode(node, "prompt-path");
	const promptPath = promptPathNode ? getStringArgument(promptPathNode) : undefined;
	if (promptPath !== undefined) block.systemPromptPath = promptPath;

	const contextFilesNode = getChildNode(node, "context-files");
	if (contextFilesNode) {
		const files = getStringArguments(contextFilesNode);
		if (files.length > 0) block.contextFiles = files;
	}

	const toolsNode = getChildNode(node, "tools");
	if (toolsNode) {
		const allowNode = getChildNode(toolsNode, "allow");
		const denyNode = getChildNode(toolsNode, "deny");
		if (allowNode) block.toolsAllow = getStringArguments(allowNode);
		if (denyNode) block.toolsDeny = getStringArguments(denyNode);
	}

	const knowledgeNode = getChildNode(node, "knowledge");
	if (knowledgeNode) {
		const knowledge = parseKnowledge(knowledgeNode);
		if (knowledge) block.knowledge = knowledge;
	}

	const envNode = getChildNode(node, "env");
	if (envNode) {
		const env = parseEnv(envNode);
		if (env) block.env = env;
	}

	const modelRoles = parseModelRoles(node);
	if (modelRoles) block.modelRoles = modelRoles;

	return block;
}

/** Collect all inline `domain { … }` definitions from a parsed KDL document. */
export function parseDomainBlocks(doc: Document): ParsedDomainBlock[] {
	const blocks: ParsedDomainBlock[] = [];
	for (const node of doc.nodes) {
		if (!isDomainDefinition(node)) continue;
		const parsed = parseDomainNode(node);
		if (parsed) blocks.push(parsed);
	}
	return blocks;
}

/**
 * Merge a parent domain def into a child (parent applied first, child wins).
 * Field-kind-aware:
 *  - scalars (surface, prompt, knowledge, description): child overrides.
 *  - modelRoles map: deep-merge by key, child wins.
 *  - env: union require[] + merge set{}.
 *  - tools: union deny, union allow; child allow subtracts from inherited deny.
 */
export function mergeDomainDefs(parent: ParsedDomainBlock, child: ParsedDomainBlock): ParsedDomainBlock {
	const mergedDeny = new Set<string>([...(parent.toolsDeny ?? []), ...(child.toolsDeny ?? [])]);
	const mergedAllow = new Set<string>([...(parent.toolsAllow ?? []), ...(child.toolsAllow ?? [])]);
	// allow-subtracts-deny: a child (or parent) explicit allow re-enables a
	// tool the chain denied. Apply only the child's allow as the subtractor so
	// inheritance can re-grant without listing the rest.
	for (const tool of child.toolsAllow ?? []) mergedDeny.delete(tool);

	const env: DomainEnvConfig | undefined =
		parent.env || child.env
			? {
					require: [...new Set([...(parent.env?.require ?? []), ...(child.env?.require ?? [])])],
					set: { ...(parent.env?.set ?? {}), ...(child.env?.set ?? {}) },
				}
			: undefined;
	if (env) {
		if (env.require?.length === 0) env.require = undefined;
		if (env.set && Object.keys(env.set).length === 0) env.set = undefined;
	}

	return {
		name: child.name,
		extends: undefined, // resolved
		description: child.description ?? parent.description,
		systemPrompt: child.systemPrompt ?? parent.systemPrompt,
		systemPromptPath: child.systemPromptPath ?? parent.systemPromptPath,
		contextFiles: child.contextFiles ?? parent.contextFiles,
		interactiveSurface: child.interactiveSurface ?? parent.interactiveSurface,
		knowledge: child.knowledge ?? parent.knowledge,
		env,
		modelRoles:
			parent.modelRoles || child.modelRoles
				? { ...(parent.modelRoles ?? {}), ...(child.modelRoles ?? {}) }
				: undefined,
		toolsAllow: mergedAllow.size > 0 ? [...mergedAllow] : undefined,
		toolsDeny: mergedDeny.size > 0 ? [...mergedDeny] : undefined,
	};
}

/**
 * Resolve a domain def's `extends` chain against a pool of sibling defs,
 * returning a fully-merged def. Cycles and missing parents fail loud — a
 * declarative domain that names a non-existent parent is a config error, not a
 * silent fallback.
 */
export function resolveDomainExtends(
	block: ParsedDomainBlock,
	pool: Map<string, ParsedDomainBlock>,
	seen: Set<string> = new Set(),
): ParsedDomainBlock {
	if (!block.extends) return block;
	if (seen.has(block.name)) {
		throw new Error(`Domain '${block.name}': circular extends chain (${[...seen, block.name].join(" → ")})`);
	}
	const parent = pool.get(block.extends);
	if (!parent) {
		throw new Error(
			`Domain '${block.name}': extends '${block.extends}' but no inline domain with that name is defined`,
		);
	}
	seen.add(block.name);
	const resolvedParent = resolveDomainExtends(parent, pool, seen);
	return mergeDomainDefs(resolvedParent, block);
}

/** Convert a fully-resolved domain def into a `SpellDomain` manifest. */
export function domainBlockToManifest(block: ParsedDomainBlock): SpellDomain {
	const tools: DomainToolConfig = {};
	if (block.toolsAllow && block.toolsAllow.length > 0) tools.include = block.toolsAllow;
	if (block.toolsDeny && block.toolsDeny.length > 0) tools.exclude = block.toolsDeny;

	return {
		name: block.name,
		description: block.description ?? `Declarative domain '${block.name}'`,
		systemPrompt: block.systemPrompt,
		systemPromptPath: block.systemPromptPath,
		contextFiles: block.contextFiles,
		tools,
		panels: [],
		workspaces: [],
		interactiveSurface: block.interactiveSurface,
		knowledge: block.knowledge,
		env: block.env,
		modelRoles: block.modelRoles,
	};
}

/**
 * Build a name→`SpellDomain` map from a set of parsed domain blocks, resolving
 * every `extends` chain. The single entry point used by the loader.
 */
export function resolveDomainManifests(blocks: ParsedDomainBlock[]): Map<string, SpellDomain> {
	const pool = new Map<string, ParsedDomainBlock>();
	for (const block of blocks) pool.set(block.name, block);
	const out = new Map<string, SpellDomain>();
	for (const block of blocks) {
		const resolved = resolveDomainExtends(block, pool);
		out.set(resolved.name, domainBlockToManifest(resolved));
	}
	return out;
}

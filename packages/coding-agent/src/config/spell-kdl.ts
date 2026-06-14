import * as path from "node:path";
import { Document, format, parse } from "@bgotink/kdl";
import { getAgentDir, isEnoent, logger } from "@spell/pi-utils";

import type { ModeConfig, ModeConfigFrontmatter } from "../capability/mode";
import { createSourceMeta } from "../discovery/helpers";

import { resolveTemplate } from "../templates";
import { type AgentRulesConfig, parseAgentsBlock } from "./agents-kdl";
import { getStringArgument } from "./kdl-helpers";
import { parseKeybindingsBlock } from "./kdl-keybindings";
import type { SpellDomain } from "../domain/loader";
import { isDomainDefinition, parseDomainBlocks, resolveDomainManifests } from "./kdl-domains";
import type { ParsedModeBlock } from "./kdl-modes";
import { parseModeBlocks } from "./kdl-modes";
import type { Discipline } from "./discipline";
import { parseDisciplineBlocks } from "./kdl-discipline";
import { policyToDiscipline } from "./discipline";
import bundledDisciplinesKdl from "./bundled-disciplines.kdl" with { type: "text" };
import { type KdlProviderConfig, parseProvidersBlock } from "./kdl-providers";
import { kdlDocumentToSettings } from "./kdl-reader";
import type { RawSettings } from "./settings";
import type { TaskPolicyConfig } from "./task-policies";
import { parseTaskPoliciesKdl } from "./task-policies-kdl";

export interface SpellProjectConfig {
	domain?: string;
	/**
	 * Inline `domain "x" { … }` definitions (declarative domains). Keyed by
	 * name, with `extends` chains already resolved into full `SpellDomain`
	 * manifests. The loader prefers these over built-in/workspace manifests.
	 */
	domainDefs?: Map<string, SpellDomain>;
	policies: TaskPolicyConfig;
	settings: RawSettings;
	providers?: {
		providers: Record<string, KdlProviderConfig>;
		webSearch?: string;
		codeSearch?: string;
		image?: string;
	};
	keybindings?: Record<string, string>;
	modes?: ParsedModeBlock[];
	/** First-class `discipline` blocks (FEAT-816). mode/policy desugar separately. */
	disciplines?: Discipline[];
	agents?: AgentRulesConfig;
}

function createEmptyConfig(): SpellProjectConfig {
	return {
		domain: undefined,
		policies: { version: 1, layers: {}, policies: [] },
		settings: {},
		agents: { rules: [], conflicts: [] },
	};
}

function mergeRawSettings(base: RawSettings, override: RawSettings): RawSettings {
	const result: RawSettings = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const baseValue = result[key];
		if (
			baseValue &&
			value &&
			typeof baseValue === "object" &&
			typeof value === "object" &&
			!Array.isArray(baseValue) &&
			!Array.isArray(value)
		) {
			result[key] = mergeRawSettings(baseValue as RawSettings, value as RawSettings);
		} else {
			result[key] = value;
		}
	}
	return result;
}

function mergeSpellConfigs(base: SpellProjectConfig, override: SpellProjectConfig): SpellProjectConfig {
	const mergedLayers = { ...base.policies.layers, ...override.policies.layers };
	const overridePolicyNames = new Set(override.policies.policies.map(policy => policy.name));
	const mergedPolicies = [
		...base.policies.policies.filter(policy => !overridePolicyNames.has(policy.name)),
		...override.policies.policies,
	];
	const providers =
		base.providers || override.providers
			? {
					providers: { ...(base.providers?.providers ?? {}), ...(override.providers?.providers ?? {}) },
					webSearch: override.providers?.webSearch ?? base.providers?.webSearch,
					codeSearch: override.providers?.codeSearch ?? base.providers?.codeSearch,
					image: override.providers?.image ?? base.providers?.image,
				}
			: undefined;
	const keybindings =
		base.keybindings || override.keybindings
			? { ...(base.keybindings ?? {}), ...(override.keybindings ?? {}) }
			: undefined;
	const modes = [...(base.modes ?? []), ...(override.modes ?? [])];
	// Disciplines merge by name: override wins (project over user).
	const overrideDisciplineNames = new Set((override.disciplines ?? []).map(d => d.name));
	const disciplines = [
		...(base.disciplines ?? []).filter(d => !overrideDisciplineNames.has(d.name)),
		...(override.disciplines ?? []),
	];
	const agents =
		base.agents || override.agents
			? {
					rules: [...(base.agents?.rules ?? []), ...(override.agents?.rules ?? [])],
					conflicts: [],
				}
			: undefined;

	const domainDefs =
		base.domainDefs || override.domainDefs
			? new Map([...(base.domainDefs ?? []), ...(override.domainDefs ?? [])])
			: undefined;

	return {
		domain: override.domain ?? base.domain,
		domainDefs,
		policies: { version: 1, layers: mergedLayers, policies: mergedPolicies },
		settings: mergeRawSettings(base.settings, override.settings),
		providers,
		keybindings,
		modes: modes.length > 0 ? modes : undefined,
		disciplines: disciplines.length > 0 ? disciplines : undefined,
		agents,
	};
}

function getModeFrontmatter(block: ParsedModeBlock): ModeConfigFrontmatter {
	return block.config as ModeConfigFrontmatter;
}

function validateSpellModeFrontmatter(
	frontmatter: ModeConfigFrontmatter,
	sourcePath: string,
	modeName: string,
): string | undefined {
	if (frontmatter.tools) {
		if (frontmatter.tools.allow !== undefined && !Array.isArray(frontmatter.tools.allow)) {
			return `Mode "${modeName}" at ${sourcePath}: tools.allow must be a string array, got ${typeof frontmatter.tools.allow}`;
		}
		if (frontmatter.tools.deny !== undefined && !Array.isArray(frontmatter.tools.deny)) {
			return `Mode "${modeName}" at ${sourcePath}: tools.deny must be a string array, got ${typeof frontmatter.tools.deny}`;
		}
	}
	if (frontmatter.extends !== undefined && typeof frontmatter.extends !== "string") {
		return `Mode "${modeName}" at ${sourcePath}: extends must be a string, got ${typeof frontmatter.extends}`;
	}
	if (frontmatter.command !== undefined && typeof frontmatter.command !== "string") {
		return `Mode "${modeName}" at ${sourcePath}: command must be a string, got ${typeof frontmatter.command}`;
	}
	return undefined;
}

export async function spellKdlModesToModeConfigs(
	blocks: ParsedModeBlock[],
	sourcePath: string,
	_projectDir: string,
	sourceId = "spell.kdl",
): Promise<{ items: ModeConfig[]; warnings: string[] }> {
	const items: ModeConfig[] = [];
	const warnings: string[] = [];
	for (const block of blocks) {
		const frontmatter = getModeFrontmatter(block);
		const warning = validateSpellModeFrontmatter(frontmatter, sourcePath, block.name);
		if (warning) {
			warnings.push(warning);
			continue;
		}
		items.push({
			name: block.name,
			path: sourcePath,
			frontmatter,
			sections: block.sections,
			level: "project",
			_source: createSourceMeta(sourceId, sourcePath, "project"),
		});
	}
	return { items, warnings };
}

function loadImportedConfig(
	ns: string,
	baseDir: string | undefined,
	visited: Set<string>,
): Promise<SpellProjectConfig | undefined> | undefined {
	if (ns.startsWith("./") || ns.startsWith("../")) {
		if (!baseDir) {
			logger.warn("spell-kdl: relative import without baseDir, skipping", { namespace: ns });
			return undefined;
		}

		const importPath = path.resolve(baseDir, ns);
		if (visited.has(importPath)) {
			logger.warn("spell-kdl: import cycle detected, skipping", { filePath: importPath });
			return undefined;
		}

		visited.add(importPath);
		return Bun.file(importPath)
			.text()
			.then(async content => parseSpellKdl(content, path.dirname(importPath), visited))
			.catch(error => {
				if (isEnoent(error)) {
					logger.warn("spell-kdl: imported file missing, skipping", { filePath: importPath });
					return undefined;
				}
				throw error;
			})
			.finally(() => {
				visited.delete(importPath);
			});
	}

	const templateContent = resolveTemplate(ns);
	if (!templateContent) {
		logger.warn("spell-kdl: unknown import namespace, skipping", { namespace: ns });
		return undefined;
	}

	const templateConfig = parseTaskPoliciesKdl(templateContent);
	if (!templateConfig) {
		logger.warn("spell-kdl: failed to parse template", { namespace: ns });
		return undefined;
	}

	return Promise.resolve({ domain: undefined, policies: templateConfig, settings: {} });
}

export async function parseSpellKdl(
	content: string,
	baseDir?: string,
	visited: Set<string> = new Set(),
): Promise<SpellProjectConfig> {
	let document: Document;
	try {
		document = parse(content);
	} catch (error) {
		logger.warn("spell-kdl: parse error", { error: error instanceof Error ? error.message : String(error) });
		return createEmptyConfig();
	}

	let result = createEmptyConfig();
	for (const node of document.nodes) {
		switch (node.getName()) {
			case "domain":
				// A `domain "x"` selector (no children) names the active domain.
				// A `domain "x" { … }` definition is a declarative domain and is
				// collected separately below (parseDomainBlocks) — it does NOT set
				// the active-domain selector.
				if (!isDomainDefinition(node)) {
					result.domain = getStringArgument(node);
				}
				break;
			case "import": {
				const ns = getStringArgument(node);
				if (!ns) break;
				const importedConfig = await loadImportedConfig(ns, baseDir, visited);
				if (importedConfig) result = mergeSpellConfigs(result, importedConfig);
				break;
			}
			case "layer":
			case "policy":
				break;
			case "agents": {
				const parsed = parseAgentsBlock(node, baseDir);
				if (parsed.rules.length > 0) {
					result.agents = {
						rules: [...(result.agents?.rules ?? []), ...parsed.rules],
						conflicts: [],
					};
				}
				break;
			}
			default:
				break;
		}
	}

	result.settings = mergeRawSettings(result.settings, kdlDocumentToSettings(document));
	const providersBlock = parseProvidersBlock(document);
	if (
		Object.keys(providersBlock.providers).length > 0 ||
		providersBlock.webSearch ||
		providersBlock.codeSearch ||
		providersBlock.image
	) {
		result.providers = result.providers
			? {
					providers: { ...result.providers.providers, ...providersBlock.providers },
					webSearch: providersBlock.webSearch ?? result.providers.webSearch,
					codeSearch: providersBlock.codeSearch ?? result.providers.codeSearch,
					image: providersBlock.image ?? result.providers.image,
				}
			: providersBlock;
	}
	const keybindings = parseKeybindingsBlock(document);
	if (Object.keys(keybindings).length > 0) {
		result.keybindings = { ...(result.keybindings ?? {}), ...keybindings };
	}
	const modes = parseModeBlocks(document);
	if (modes.length > 0) {
		result.modes = [...(result.modes ?? []), ...modes];
	}
	const disciplines = parseDisciplineBlocks(document);
	if (disciplines.length > 0) {
		result.disciplines = [...(result.disciplines ?? []), ...disciplines];
	}

	// Inline `domain "x" { … }` definitions → resolved SpellDomain manifests.
	// extends/cycle errors are config errors: surface as a warning and skip the
	// offending set rather than aborting the whole config load.
	const domainBlocks = parseDomainBlocks(document);
	if (domainBlocks.length > 0) {
		try {
			const resolved = resolveDomainManifests(domainBlocks);
			result.domainDefs = result.domainDefs
				? new Map([...result.domainDefs, ...resolved])
				: resolved;
		} catch (error) {
			logger.warn("spell-kdl: domain definition error", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	const localPolicyConfig = parseTaskPoliciesKdl(
		format(new Document(document.nodes.filter(node => node.getName() === "layer" || node.getName() === "policy"))),
	);
	if (localPolicyConfig) {
		result.policies = mergeSpellConfigs(result, {
			domain: undefined,
			policies: localPolicyConfig,
			settings: {},
		}).policies;
	}

	return result;
}

/**
 * The unified discipline set for a config: first-class `discipline` blocks plus
 * every `policy` desugared into one. (Workflow `mode` roles desugar at the
 * capability layer where {@link ModeConfig} objects are available; this accessor
 * covers the config-resolvable triggers — tool/layer/auto/manual-from-discipline.)
 *
 * Dedup by name: an explicit `discipline` overrides a same-named desugared policy.
 */
export function unifiedDisciplines(config: SpellProjectConfig): Discipline[] {
	const explicit = config.disciplines ?? [];
	const explicitNames = new Set(explicit.map(d => d.name));
	const fromPolicies = config.policies.policies
		.map(policyToDiscipline)
		.filter(d => !explicitNames.has(d.name));
	return [...explicit, ...fromPolicies];
}

export async function loadSpellKdl(projectDir: string): Promise<SpellProjectConfig | undefined> {
	const spellKdlPath = `${projectDir}/spell.kdl`;
	try {
		const content = await Bun.file(spellKdlPath).text();
		return await parseSpellKdl(content, projectDir);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		logger.warn("spell-kdl: failed to load spell.kdl", {
			filePath: spellKdlPath,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

export async function loadUserSpellKdl(agentDir = getAgentDir()): Promise<SpellProjectConfig | undefined> {
	const spellKdlPath = path.join(path.dirname(agentDir), "spell.kdl");
	try {
		const content = await Bun.file(spellKdlPath).text();
		return await parseSpellKdl(content, path.dirname(spellKdlPath));
	} catch (error) {
		if (isEnoent(error)) return undefined;
		logger.warn("spell-kdl: failed to load user spell.kdl", {
			filePath: spellKdlPath,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

/**
 * Load + merge user and project spell.kdl into one `SpellProjectConfig`.
 * Single merge path; narrower accessors (providers, domainDefs) derive from it.
 */
export async function loadMergedSpellConfig(
	projectDir: string,
	agentDir = getAgentDir(),
): Promise<SpellProjectConfig> {
	const [userConfig, projectConfig] = await Promise.all([loadUserSpellKdl(agentDir), loadSpellKdl(projectDir)]);
	return mergeSpellConfigs(userConfig ?? createEmptyConfig(), projectConfig ?? createEmptyConfig());
}

export async function loadMergedProviderConfigs(
	projectDir: string,
	agentDir = getAgentDir(),
): Promise<Record<string, KdlProviderConfig> | undefined> {
	const mergedConfig = await loadMergedSpellConfig(projectDir, agentDir);
	const providers = mergedConfig.providers?.providers;
	if (!providers || Object.keys(providers).length === 0) return undefined;
	return providers;
}

/**
 * Unified disciplines from merged user+project config: explicit `discipline`
 * blocks ∪ desugared `policy` blocks. Consumed by the session for tool/layer
 * triggered injection (FEAT-816). Manual (role) triggers flow via ModeConfig.
 */
export async function loadMergedDisciplines(
	projectDir: string,
	agentDir = getAgentDir(),
): Promise<Discipline[]> {
	const mergedConfig = await loadMergedSpellConfig(projectDir, agentDir);
	const configured = unifiedDisciplines(mergedConfig);
	// Bundled defaults are the base layer — available in EVERY repo. User/project
	// disciplines override them by name (configured wins on conflict).
	const configuredNames = new Set(configured.map(d => d.name));
	const bundled = parseBundledDisciplines().filter(d => !configuredNames.has(d.name));
	return [...bundled, ...configured];
}

let bundledDisciplinesCache: Discipline[] | null = null;
function parseBundledDisciplines(): Discipline[] {
	if (bundledDisciplinesCache) return bundledDisciplinesCache;
	try {
		bundledDisciplinesCache = parseDisciplineBlocks(parse(bundledDisciplinesKdl));
	} catch (error) {
		logger.warn("disciplines: failed to parse bundled defaults", {
			error: error instanceof Error ? error.message : String(error),
		});
		bundledDisciplinesCache = [];
	}
	return bundledDisciplinesCache;
}

/** Inline KDL domain definitions from merged user+project config (or undefined). */
export async function loadDomainDefs(
	projectDir: string,
	agentDir = getAgentDir(),
): Promise<Map<string, SpellDomain> | undefined> {
	const mergedConfig = await loadMergedSpellConfig(projectDir, agentDir);
	return mergedConfig.domainDefs;
}

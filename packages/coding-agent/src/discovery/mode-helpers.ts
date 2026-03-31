import type { ModeConfig, ModeConfigFrontmatter, ModeConfigSections, ResolvedModeConfig } from "../capability/mode";

const KNOWN_SECTIONS: Record<string, keyof Omit<ModeConfigSections, "custom">> = {
	context: "context",
	instructions: "instructions",
	"focus areas": "focusAreas",
	examples: "examples",
	"plan phase": "planPhase",
	"code phase": "codePhase",
	"review phase": "reviewPhase",
};

export function parseModeConfigSections(body: string): ModeConfigSections {
	const sections: ModeConfigSections = { custom: {} };
	const headingRe = /^##\s+(.+)$/gm;
	let lastHeading: string | null = null;
	let lastIndex = 0;
	const parts: Array<{ heading: string; content: string }> = [];

	for (;;) {
		const match = headingRe.exec(body);
		if (match === null) break;
		if (lastHeading !== null) {
			parts.push({ heading: lastHeading, content: body.slice(lastIndex, match.index).trim() });
		}
		lastHeading = match[1].trim();
		lastIndex = match.index + match[0].length;
	}

	if (lastHeading !== null) {
		parts.push({ heading: lastHeading, content: body.slice(lastIndex).trim() });
	}

	for (const part of parts) {
		const key = KNOWN_SECTIONS[part.heading.toLowerCase()];
		if (key) {
			sections[key] = part.content;
		} else {
			sections.custom[part.heading] = part.content;
		}
	}

	return sections;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMergeFrontmatter(
	parent: ModeConfigFrontmatter,
	child: ModeConfigFrontmatter,
): ModeConfigFrontmatter {
	const result = { ...parent } as Record<string, unknown>;

	for (const key of Object.keys(child) as Array<keyof ModeConfigFrontmatter>) {
		const childVal = child[key];
		if (childVal === undefined) continue;

		if (Array.isArray(childVal)) {
			// Arrays: child replaces parent
			result[key] = childVal;
		} else if (isPlainObject(childVal) && isPlainObject(result[key])) {
			// Objects: recursive merge
			result[key] = deepMergeFrontmatter(result[key] as ModeConfigFrontmatter, childVal as ModeConfigFrontmatter);
		} else {
			// Scalars: child wins
			result[key] = childVal;
		}
	}

	return result as ModeConfigFrontmatter;
}

const SECTION_KEYS: Array<keyof Omit<ModeConfigSections, "custom">> = [
	"context",
	"instructions",
	"focusAreas",
	"examples",
	"planPhase",
	"codePhase",
	"reviewPhase",
];

export function mergeSections(parent: ModeConfigSections, child: ModeConfigSections): ModeConfigSections {
	const result: ModeConfigSections = { custom: {} };

	for (const key of SECTION_KEYS) {
		const p = parent[key];
		const c = child[key];
		if (p && c) {
			result[key] = `${p}\n\n${c}`;
		} else {
			result[key] = c ?? p;
		}
	}

	// Custom sections: merge maps, child wins on collision
	result.custom = { ...parent.custom, ...child.custom };

	return result;
}

export function detectExtendsCycle(
	modeName: string,
	allModes: Map<string, ModeConfig>,
	builtinModes: Map<string, ModeConfig>,
): string[] | null {
	const visited = new Set<string>();
	const chain: string[] = [];
	let current: string | undefined = modeName;

	while (current) {
		if (visited.has(current)) {
			chain.push(current);
			return chain;
		}
		visited.add(current);
		chain.push(current);

		const mode: ModeConfig | undefined = allModes.get(current) ?? builtinModes.get(current);
		current = mode?.frontmatter.extends;
	}

	return null;
}

export function resolveToolAccess(chain: ModeConfigFrontmatter[]): string[] | undefined {
	let tools: Set<string> | undefined;

	// Walk parent-first (chain[0] is root parent, last is the mode itself)
	for (const fm of chain) {
		if (fm.tools?.allow) {
			tools = new Set(fm.tools.allow);
		}
		if (fm.tools?.deny && tools) {
			for (const denied of fm.tools.deny) {
				tools.delete(denied);
			}
		}
	}

	return tools ? [...tools] : undefined;
}

function lookupMode(
	name: string,
	allModes: Map<string, ModeConfig>,
	builtinModes: Map<string, ModeConfig>,
): ModeConfig | undefined {
	return allModes.get(name) ?? builtinModes.get(name);
}

export function resolveModeConfig(
	mode: ModeConfig,
	allModes: Map<string, ModeConfig>,
	builtinModes: Map<string, ModeConfig>,
): ResolvedModeConfig {
	// Check for cycles first
	const cycle = detectExtendsCycle(mode.name, allModes, builtinModes);
	if (cycle) {
		throw new Error(`Circular extends detected in mode "${mode.name}": ${cycle.join(" -> ")}`);
	}

	// Build the chain from root ancestor to mode (parent first)
	const chain: ModeConfig[] = [];
	let current: ModeConfig | undefined = mode;

	while (current) {
		chain.unshift(current);
		const parentName = current.frontmatter.extends;
		if (!parentName) break;

		const parent = lookupMode(parentName, allModes, builtinModes);
		if (!parent) {
			throw new Error(`Mode "${current.name}" extends "${parentName}", but "${parentName}" was not found`);
		}
		current = parent;
	}

	const extendsChain = chain.map(m => m.name);

	// Merge frontmatter and sections along the chain
	let mergedFrontmatter = chain[0].frontmatter;
	let mergedSections = chain[0].sections;

	for (let i = 1; i < chain.length; i++) {
		mergedFrontmatter = deepMergeFrontmatter(mergedFrontmatter, chain[i].frontmatter);
		mergedSections = mergeSections(mergedSections, chain[i].sections);
	}

	// Resolve tool access
	const frontmatterChain = chain.map(m => m.frontmatter);
	const resolvedTools = resolveToolAccess(frontmatterChain);

	return {
		name: mode.name,
		path: mode.path,
		frontmatter: mergedFrontmatter,
		sections: mergedSections,
		level: mode.level,
		_source: mode._source,
		resolvedTools,
		extendsChain,
	};
}

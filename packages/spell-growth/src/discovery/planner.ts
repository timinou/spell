import type { GrowthDiscoveryPlan, GrowthDiscoveryQuery, GrowthPersonaRecord, GrowthSourceRecord } from "../types";
import { normalizeSourceValue } from "../registries/source-loader";

function createQuery(
	sourceSlug: string,
	index: number,
	kind: GrowthDiscoveryQuery["kind"],
	query: string,
	label: string,
	reason: string,
	source?: GrowthSourceRecord,
): GrowthDiscoveryQuery {
	return {
		id: `${sourceSlug}:${kind}:${index}`,
		kind,
		label,
		reason,
		query,
		...(source ? { sourceKind: source.kind, sourceValue: source.value } : {}),
	};
}

function buildDirectQuery(source: GrowthSourceRecord): string {
	const normalized = normalizeSourceValue(source.kind, source.value);
	if (source.kind === "website" || source.kind === "rss" || source.kind === "newsletter") {
		return `site:${normalized.split("/")[0] ?? normalized} article`;
	}
	if (source.kind === "x") {
		return `site:x.com/${normalized} article`;
	}
	if (source.kind === "linkedin") {
		return `site:linkedin.com/in/${normalized} article`;
	}
	return source.value.trim();
}

function buildAdjacentThemes(personas: GrowthPersonaRecord[]): string[] {
	const themes: string[] = [];
	for (const persona of personas) {
		for (const keyword of persona.keywords.slice(0, 1)) {
			themes.push(keyword);
		}
	}
	return [...new Set(themes)];
}

export function buildDiscoveryPlan(
	sources: GrowthSourceRecord[],
	personas: GrowthPersonaRecord[],
	adjacentThemes = buildAdjacentThemes(personas),
): GrowthDiscoveryPlan {
	const directSources = sources
		.filter(source => source.direct && source.kind !== "search")
		.sort((left, right) => left.priority - right.priority);
	const fallbackSources = sources.filter(source => source.kind === "search");
	const directQueries = directSources.map((source, index) =>
		createQuery(
			source.slug,
			index,
			"direct",
			buildDirectQuery(source),
			`${source.kind}:${source.slug}`,
			`Direct source query for ${source.slug}`,
			source,
		),
	);
	const fallbackQueries = (directQueries.length === 0 ? fallbackSources : []).map((source, index) =>
		createQuery(
			source.slug,
			index,
			"fallback",
			source.value.trim(),
			`fallback:${source.slug}`,
			"Fallback search because no direct source exists",
			source,
		),
	);
	const adjacentQueries = adjacentThemes.map((theme, index) =>
		createQuery(
			`adjacent-${index + 1}`,
			index,
			"adjacent",
			`${theme} growth research`,
			`adjacent:${theme}`,
			"Adjacent research expansion",
		),
	);
	return {
		directQueries,
		fallbackQueries,
		adjacentQueries,
		allQueries: [...directQueries, ...fallbackQueries, ...adjacentQueries],
	};
}

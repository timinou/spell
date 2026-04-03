import type { GrowthDiscoveredCandidate } from "../types";

function precedence(kind: GrowthDiscoveredCandidate["provenanceMode"]): number {
	if (kind === "direct") return 3;
	if (kind === "fallback") return 2;
	return 1;
}

export function normalizeCanonicalUrl(url: string): string | undefined {
	try {
		const parsed = new URL(url);
		for (const key of [...parsed.searchParams.keys()]) {
			if (key.startsWith("utm_") || key === "ref" || key === "source") {
				parsed.searchParams.delete(key);
			}
		}
		parsed.hash = "";
		if (parsed.searchParams.toString() === "") {
			parsed.search = "";
		}
		return parsed.toString();
	} catch {
		return undefined;
	}
}

export function normalizePublishedAt(publishedAt?: string): string | undefined {
	const trimmed = publishedAt?.trim();
	if (!trimmed) {
		return undefined;
	}
	if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
		return `${trimmed}T00:00:00.000Z`;
	}
	const parsed = new Date(trimmed);
	return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function canonicalizeCandidate(candidate: GrowthDiscoveredCandidate): GrowthDiscoveredCandidate {
	return {
		...candidate,
		canonicalUrl: normalizeCanonicalUrl(candidate.canonicalUrl) ?? candidate.canonicalUrl,
		publishedAt: normalizePublishedAt(candidate.publishedAt),
	};
}

export function dedupeCandidates(candidates: GrowthDiscoveredCandidate[]): GrowthDiscoveredCandidate[] {
	const deduped = new Map<string, GrowthDiscoveredCandidate>();
	for (const candidate of candidates.map(canonicalizeCandidate)) {
		const existing = deduped.get(candidate.canonicalUrl);
		if (!existing) {
			deduped.set(candidate.canonicalUrl, candidate);
			continue;
		}
		if (precedence(candidate.provenanceMode) > precedence(existing.provenanceMode)) {
			deduped.set(candidate.canonicalUrl, candidate);
		}
	}
	return [...deduped.values()];
}

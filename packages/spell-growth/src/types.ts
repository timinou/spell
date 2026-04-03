export type GrowthSourceKind = "website" | "rss" | "x" | "linkedin" | "newsletter" | "search";

export interface GrowthSourceRecord {
	slug: string;
	label: string;
	kind: GrowthSourceKind;
	value: string;
	direct: boolean;
	priority: number;
	profileUrl?: string;
}

export interface GrowthPersonaRecord {
	slug: string;
	name: string;
	summary: string;
	goals: string[];
	challenges: string[];
	keywords: string[];
}

export interface GrowthDiscoveryQuery {
	id: string;
	kind: "direct" | "fallback" | "adjacent";
	label: string;
	reason: string;
	query: string;
	sourceKind?: GrowthSourceKind;
	sourceValue?: string;
}

export interface GrowthDiscoveryPlan {
	directQueries: GrowthDiscoveryQuery[];
	fallbackQueries: GrowthDiscoveryQuery[];
	adjacentQueries: GrowthDiscoveryQuery[];
	allQueries: GrowthDiscoveryQuery[];
}

export interface GrowthExaResult {
	url: string;
	title: string;
	summary?: string;
	text?: string;
	publishedAt?: string;
}

export interface GrowthDiscoveredCandidate {
	canonicalUrl: string;
	sourceUrl: string;
	title: string;
	summary?: string;
	publishedAt?: string;
	sourceSlug: string;
	sourceLabel: string;
	provenanceMode: GrowthDiscoveryQuery["kind"];
	matchedQueryId: string;
	matchedQuery: string;
	contentFingerprint: string;
	rawResult: unknown;
}

export interface GrowthPersonaScore {
	persona: GrowthPersonaRecord;
	score: number;
	matchedKeywords: string[];
	matchedChallenges: string[];
	rationale: string;
}

export interface GrowthReviewRecord {
	candidate: GrowthDiscoveredCandidate;
	scores: GrowthPersonaScore[];
	reviewItemId: string;
}

export interface GrowthFeedDigestItem {
	id: string;
	title: string;
	summary: string;
	canonicalUrl: string;
	personaSlug?: string;
}

export interface GrowthPublicationItem {
	id: string;
	title: string;
	summary: string;
	canonicalUrl: string;
	body: string;
	publishedAt?: string;
}

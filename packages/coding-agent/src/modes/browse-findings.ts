import * as crypto from "node:crypto";

export type FindingSourceType = 'search' | 'fetch' | 'code_search' | 'browser' | 'agent';

const VALID_SOURCE_TYPES: ReadonlySet<string> = new Set<FindingSourceType>(['search', 'fetch', 'code_search', 'browser', 'agent']);

export interface BrowseFinding {
	id: string;
	url: string;
	title: string;
	excerpt: string;
	tags: string[];
	sourceType: FindingSourceType;
	curated: boolean;
	enriched: boolean;
	contentBody?: string;
	tabId?: string;
	timestamp: number;
}

export interface BrowseFindingInput {
	id?: string;
	url: string;
	title: string;
	excerpt?: string;
	tags?: string[];
	sourceType?: FindingSourceType;
	curated?: boolean;
	contentBody?: string;
	enriched?: boolean;
	tabId?: string;
	timestamp?: number;
}

function cleanString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function cleanTags(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map(tag => cleanString(tag)).filter(Boolean);
}

export function createFindingTabId(): string {
	return `finding-${crypto.randomUUID()}`;
}

export function createFinding(input: BrowseFindingInput): BrowseFinding {
	const timestamp = Number.isFinite(input.timestamp) ? Number(input.timestamp) : Date.now();
	const tabId = cleanString(input.tabId);
	const contentBody = cleanString(input.contentBody);
	return {
		id: cleanString(input.id) || crypto.randomUUID(),
		url: cleanString(input.url),
		title: cleanString(input.title),
		excerpt: cleanString(input.excerpt),
		tags: cleanTags(input.tags),
		sourceType: input.sourceType ?? 'agent',
		curated: input.curated ?? true,
		enriched: input.enriched ?? false,
		timestamp,
		...(contentBody ? { contentBody } : {}),
		...(tabId ? { tabId } : {}),
	};
}

export function parseBrowseFinding(value: unknown): BrowseFinding | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const record = value as Record<string, unknown>;
	const url = cleanString(record.url);
	const title = cleanString(record.title);
	if (!url || !title) {
		return null;
	}
	const rawSourceType = cleanString(record.sourceType);
	return createFinding({
		id: cleanString(record.id) || undefined,
		url,
		title,
		excerpt: cleanString(record.excerpt) || undefined,
		tags: cleanTags(record.tags),
		sourceType: VALID_SOURCE_TYPES.has(rawSourceType) ? rawSourceType as FindingSourceType : undefined,
		curated: typeof record.curated === 'boolean' ? record.curated : undefined,
		contentBody: cleanString(record.contentBody) || undefined,
		enriched: typeof record.enriched === 'boolean' ? record.enriched : undefined,
		tabId: cleanString(record.tabId) || undefined,
		timestamp: Number.isFinite(record.timestamp) ? Number(record.timestamp) : undefined,
	});
}


export function normalizeUrlForDedup(url: string): string {
	if (!url) return '';
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return url.toLowerCase();
	}
	const host = parsed.hostname.replace(/^www\./, '');
	const path = parsed.pathname.replace(/\/$/, '');
	return `${parsed.protocol.toLowerCase()}//${host}${path}${parsed.search}`;
}
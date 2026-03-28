import * as crypto from "node:crypto";

export interface BrowseFinding {
	id: string;
	url: string;
	title: string;
	excerpt: string;
	tags: string[];
	tabId?: string;
	timestamp: number;
}

export interface BrowseFindingInput {
	id?: string;
	url: string;
	title: string;
	excerpt?: string;
	tags?: string[];
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
	return {
		id: cleanString(input.id) || crypto.randomUUID(),
		url: cleanString(input.url),
		title: cleanString(input.title),
		excerpt: cleanString(input.excerpt),
		tags: cleanTags(input.tags),
		timestamp,
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
	return createFinding({
		id: cleanString(record.id) || undefined,
		url,
		title,
		excerpt: cleanString(record.excerpt) || undefined,
		tags: cleanTags(record.tags),
		tabId: cleanString(record.tabId) || undefined,
		timestamp: Number.isFinite(record.timestamp) ? Number(record.timestamp) : undefined,
	});
}

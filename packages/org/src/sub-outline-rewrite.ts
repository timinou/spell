import { DEFAULT_ORG_CONFIG } from "./schema/defaults";

export interface RewriteSubOutlineIdsResult {
	body: string;
	rewrites: Map<string, string>;
}

const CUSTOM_ID_LINE_RE = /^(\s*:CUSTOM_ID:\s+)(\S+)(\s*)$/;
const DEPENDS_LINE_RE = /^(\s*:DEPENDS:\s+)(.+?)(\s*)$/;
const PROPERTIES_START_RE = /^\s*:PROPERTIES:\s*$/;
const PROPERTIES_END_RE = /^\s*:END:\s*$/;
const SECOND_LEVEL_HEADING_RE = /^(\s*)(\*\*)(\s+)(.*)$/;
const ANY_HEADING_RE = /^\s*\*+\s/;
const SEPARATOR_RE = /^([,\s]+)$/;
const VALID_SUBOUTLINE_SLUG_RE = /^[A-Za-z0-9_-]+$/;

function buildPrefixedId(parentId: string, localId: string): string {
	return `${parentId}::${localId}`;
}

function normalizeLocalSuboutlineId(parentId: string, candidate: string): string | null {
	const prefixedPrefix = `${parentId}::`;
	const parentNumericPrefix = parentId.match(/^[A-Z]+-\d+/)?.[0] ?? null;

	if (candidate.startsWith(prefixedPrefix)) {
		const suffix = candidate.slice(prefixedPrefix.length);
		return VALID_SUBOUTLINE_SLUG_RE.test(suffix) ? candidate : null;
	}

	if (!candidate.includes("::")) {
		return VALID_SUBOUTLINE_SLUG_RE.test(candidate) ? buildPrefixedId(parentId, candidate) : null;
	}

	const [left, suffix] = candidate.split("::", 2);
	if (!VALID_SUBOUTLINE_SLUG_RE.test(suffix)) return null;
	if (left === "") return buildPrefixedId(parentId, suffix);
	if (!parentNumericPrefix || left !== parentNumericPrefix) return null;
	return buildPrefixedId(parentId, suffix);
}

function collectRewriteMap(parentId: string, body: string): Map<string, string> {
	const rewrites = new Map<string, string>();

	for (const line of body.split("\n")) {
		const match = CUSTOM_ID_LINE_RE.exec(line);
		if (!match) continue;

		const customId = match[2];
		const normalized = normalizeLocalSuboutlineId(parentId, customId);
		if (!normalized || normalized === customId) continue;
		rewrites.set(customId, normalized);
	}

	return rewrites;
}

function rewriteDependsValue(parentId: string, dependsValue: string, rewrites: Map<string, string>): string {
	return dependsValue
		.split(/([,\s]+)/)
		.map(token => {
			if (token.length === 0 || SEPARATOR_RE.test(token)) return token;
			return rewrites.get(token) ?? normalizeLocalSuboutlineId(parentId, token) ?? token;
		})
		.join("");
}

function hasTodoKeyword(text: string, todoKeywords: string[]): boolean {
	const knownKeywords = new Set([...todoKeywords, "TODO"]);
	return [...knownKeywords].some(keyword => text === keyword || text.startsWith(`${keyword} `));
}

function injectItemStateInBody(parentId: string, body: string, todoKeywords: string[]): string {
	const lines = body.split("\n");

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i]!;
		const headingMatch = SECOND_LEVEL_HEADING_RE.exec(line);
		if (!headingMatch) continue;

		const [, indent, stars, spacing, title] = headingMatch;
		if (hasTodoKeyword(title, todoKeywords)) continue;

		let inProperties = false;
		let shouldInject = false;

		for (let j = i + 1; j < lines.length; j += 1) {
			const nextLine = lines[j]!;
			if (ANY_HEADING_RE.test(nextLine)) break;
			if (PROPERTIES_START_RE.test(nextLine)) {
				inProperties = true;
				continue;
			}
			if (PROPERTIES_END_RE.test(nextLine)) break;
			if (!inProperties) {
				if (nextLine.trim().length === 0) continue;
				break;
			}

			const customIdMatch = CUSTOM_ID_LINE_RE.exec(nextLine);
			if (!customIdMatch) continue;

			const normalized = normalizeLocalSuboutlineId(parentId, customIdMatch[2]);
			if (normalized?.startsWith(`${parentId}::`)) {
				shouldInject = true;
				break;
			}
		}

		if (shouldInject) {
			lines[i] = `${indent}${stars}${spacing}ITEM ${title}`;
		}
	}

	return lines.join("\n");
}

export function rewriteSubOutlineIds(parentId: string, body: string): RewriteSubOutlineIdsResult {
	if (!body) return { body, rewrites: new Map() };

	const rewrites = collectRewriteMap(parentId, body);
	const rewrittenBody = body
		.split("\n")
		.map(line => {
			const customIdMatch = CUSTOM_ID_LINE_RE.exec(line);
			if (customIdMatch) {
				const nextId = rewrites.get(customIdMatch[2]);
				if (!nextId) return line;
				return `${customIdMatch[1]}${nextId}${customIdMatch[3]}`;
			}

			const dependsMatch = DEPENDS_LINE_RE.exec(line);
			if (!dependsMatch) return line;
			return `${dependsMatch[1]}${rewriteDependsValue(parentId, dependsMatch[2], rewrites)}${dependsMatch[3]}`;
		})
		.join("\n");

	return {
		body: injectItemStateInBody(parentId, rewrittenBody, DEFAULT_ORG_CONFIG.todoKeywords),
		rewrites,
	};
}

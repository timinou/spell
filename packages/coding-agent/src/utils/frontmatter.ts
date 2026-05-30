import type { Document, Node } from "@bgotink/kdl";
import { parse as parseKdl } from "@bgotink/kdl";
import { logger, truncate } from "@spell/pi-utils";
import { YAML } from "bun";

function stripHtmlComments(content: string): string {
	return content.replace(/<!--[\s\S]*?-->/g, "");
}

/** Convert kebab-case to camelCase (e.g. "thinking-level" -> "thinkingLevel") */
function kebabToCamel(key: string): string {
	return key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/** Recursively normalize object keys from kebab-case to camelCase */
function normalizeKeys<T>(obj: T): T {
	if (obj === null || typeof obj !== "object") return obj;
	if (Array.isArray(obj)) return obj.map(normalizeKeys) as T;

	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
		result[kebabToCamel(key)] = normalizeKeys(value);
	}
	return result as T;
}

function mergeObjectValue(target: Record<string, unknown>, key: string, value: unknown): void {
	const existing = target[key];
	if (existing === undefined) {
		target[key] = value;
		return;
	}
	if (Array.isArray(existing)) {
		target[key] = [...existing, value];
		return;
	}
	target[key] = [existing, value];
}

function kdlNodeName(node: Node): string {
	const name =
		typeof (node.name as { getName?: () => string }).getName === "function"
			? (node.name as { getName: () => string }).getName()
			: String(node.name);
	return kebabToCamel(name);
}

function kdlNodeValue(node: Node): unknown {
	const children = node.children?.nodes ?? [];
	const properties = Object.fromEntries(node.getProperties());
	const arguments_ = node.getArguments();

	if (children.length > 0) {
		const nested = kdlDocumentToObject({ nodes: children } as Document);
		if (arguments_.length === 0 && Object.keys(properties).length === 0) return nested;
		return normalizeKeys({ value: arguments_.length === 1 ? arguments_[0] : arguments_, ...properties, ...nested });
	}

	if (Object.keys(properties).length > 0) {
		return normalizeKeys({
			...properties,
			...(arguments_.length > 0 ? { value: arguments_.length === 1 ? arguments_[0] : arguments_ } : {}),
		});
	}

	if (arguments_.length === 0) return true;
	if (arguments_.length === 1) return arguments_[0];
	return arguments_;
}

function kdlDocumentToObject(doc: Document): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const node of doc.nodes) {
		mergeObjectValue(result, kdlNodeName(node), kdlNodeValue(node));
	}
	return result;
}

export class FrontmatterError extends Error {
	constructor(
		error: Error,
		readonly source?: unknown,
	) {
		super(`Failed to parse frontmatter (${source}): ${error.message}`, { cause: error });
		this.name = "FrontmatterError";
	}

	toString(): string {
		const details: string[] = [this.message];
		if (this.source !== undefined) details.push(`Source: ${JSON.stringify(this.source)}`);
		if (this.cause && typeof this.cause === "object" && "stack" in this.cause && this.cause.stack) {
			details.push(`Stack:\n${this.cause.stack}`);
		} else if (this.stack) {
			details.push(`Stack:\n${this.stack}`);
		}
		return details.join("\n\n");
	}
}

export interface FrontmatterOptions {
	/** Source of the content (alias: source) */
	location?: unknown;
	/** Source of the content (alias for location) */
	source?: unknown;
	/** Fallback frontmatter values */
	fallback?: Record<string, unknown>;
	/** Normalize the content */
	normalize?: boolean;
	/** Level of error handling */
	level?: "off" | "warn" | "fatal";
}

export interface ParsedFrontmatter {
	format: "yaml" | "kdl" | null;
	frontmatter: Record<string, unknown>;
	body: string;
}

function parseDelimitedFrontmatter(content: string): { format: "yaml" | "kdl"; metadata: string; body: string } | null {
	const firstLineEnd = content.indexOf("\n");
	const firstLine = firstLineEnd === -1 ? content : content.slice(0, firstLineEnd);

	if (firstLine === "---") {
		const endIndex = content.indexOf("\n---", firstLine.length);
		if (endIndex === -1) return null;
		return {
			format: "yaml",
			metadata: content.slice(firstLine.length + 1, endIndex),
			body: content.slice(endIndex + 4).trim(),
		};
	}

	if (firstLine === "---kdl") {
		const endIndex = content.indexOf("\n---", firstLine.length);
		if (endIndex === -1) return null;
		return {
			format: "kdl",
			metadata: content.slice(firstLine.length + 1, endIndex),
			body: content.slice(endIndex + 4).trim(),
		};
	}

	return null;
}

/**
 * Parse YAML or KDL frontmatter from markdown content.
 * Returns { frontmatter, body, format } where body has frontmatter stripped.
 */
export function parseFrontmatter(content: string, options?: FrontmatterOptions): ParsedFrontmatter {
	const { location, source, fallback, normalize = true, level = "warn" } = options ?? {};
	const loc = location ?? source;
	const frontmatter: Record<string, unknown> = { ...fallback };

	const normalized = normalize ? stripHtmlComments(content.replace(/\r\n/g, "\n").replace(/\r/g, "\n")) : content;
	const parsed = parseDelimitedFrontmatter(normalized);
	if (!parsed) {
		return { format: null, frontmatter, body: normalized };
	}

	try {
		if (parsed.format === "kdl") {
			const loaded = kdlDocumentToObject(parseKdl(parsed.metadata)) as Record<string, unknown>;
			return { format: "kdl", frontmatter: normalizeKeys({ ...frontmatter, ...loaded }), body: parsed.body };
		}

		const loaded = YAML.parse(parsed.metadata.replaceAll("\t", "  ")) as Record<string, unknown> | null;
		return { format: "yaml", frontmatter: normalizeKeys({ ...frontmatter, ...(loaded ?? {}) }), body: parsed.body };
	} catch (error) {
		const err = new FrontmatterError(
			error instanceof Error ? error : new Error(`${parsed.format.toUpperCase()}: ${error}`),
			loc ?? `Inline '${truncate(content, 64)}'`,
		);
		if (level === "warn" || level === "fatal") {
			logger.warn(`Failed to parse ${parsed.format.toUpperCase()} frontmatter`, { err: err.toString() });
		}
		if (level === "fatal") throw err;

		return {
			format: parsed.format,
			frontmatter: normalizeKeys(frontmatter) as Record<string, unknown>,
			body: parsed.body,
		};
	}
}

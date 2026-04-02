import * as path from "node:path";
import { YAML } from "bun";

export const DEFAULT_SPELLCAST_TOOLS = ["read"] as const;
export const DEFAULT_SPELLCAST_VALID_TOOLS = [
	"read",
	"write",
	"delete",
	"list",
	"grep",
	"find",
	"fetch",
	"web_search",
	"canvas",
] as const;
export const DEFAULT_SPELLCAST_VISIBILITY = "unlisted" as const;

export type SpellcastManifestVisibility = "public" | "unlisted";

export interface SpellcastManifest {
	name: string;
	description?: string;
	entry: string;
	files: string[];
	visibility: SpellcastManifestVisibility;
	tools: string[];
	auto_sync: boolean;
}

export interface ParseSpellcastManifestOptions {
	sourcePath?: string;
	validTools?: readonly string[];
}

export class SpellcastManifestError extends Error {
	readonly issues: string[];
	readonly sourcePath?: string;

	constructor(issues: string[], sourcePath?: string) {
		super(`Invalid spellcast manifest${sourcePath ? ` (${sourcePath})` : ""}: ${issues.join("; ")}`);
		this.name = "SpellcastManifestError";
		this.issues = issues;
		this.sourcePath = sourcePath;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExplicitRelativePath(value: string): boolean {
	if (!value || value.trim().length === 0) return false;
	if (path.isAbsolute(value)) return false;
	if (/^[A-Za-z]:[\\/]/.test(value)) return false;
	if (value.startsWith("~/")) return false;
	if (value.includes("*")) return false;

	const segments = value.split(/[\\/]+/);
	return !segments.some(segment => segment === "..");
}

function validateFileList(files: unknown, issues: string[]): string[] {
	if (!Array.isArray(files) || files.length === 0) {
		issues.push("files is required and must be a non-empty array");
		return [];
	}

	const result: string[] = [];
	for (const [index, file] of files.entries()) {
		if (typeof file !== "string" || !isExplicitRelativePath(file)) {
			issues.push(`files[${index}] must be an explicit relative path`);
			continue;
		}
		result.push(file);
	}
	return result;
}

function validateToolList(tools: unknown, validTools: Set<string>, issues: string[]): string[] {
	if (tools === undefined) {
		return [...DEFAULT_SPELLCAST_TOOLS];
	}
	if (!Array.isArray(tools)) {
		issues.push("tools must be an array of tool names");
		return [];
	}

	const invalid: string[] = [];
	const parsed: string[] = [];
	for (const [index, tool] of tools.entries()) {
		if (typeof tool !== "string" || tool.trim().length === 0) {
			issues.push(`tools[${index}] must be a non-empty string`);
			continue;
		}
		if (!validTools.has(tool)) {
			invalid.push(tool);
			continue;
		}
		parsed.push(tool);
	}
	if (invalid.length > 0) {
		issues.push(`unknown tools: ${invalid.join(", ")}`);
	}
	return parsed;
}

export function parseSpellcastManifest(
	rawYaml: string,
	options: ParseSpellcastManifestOptions = {},
): SpellcastManifest {
	let parsedYaml: unknown;
	try {
		parsedYaml = YAML.parse(rawYaml);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new SpellcastManifestError([`invalid YAML: ${message}`], options.sourcePath);
	}
	return validateSpellcastManifest(parsedYaml, options);
}

export function validateSpellcastManifest(
	rawManifest: unknown,
	options: ParseSpellcastManifestOptions = {},
): SpellcastManifest {
	if (!isRecord(rawManifest)) {
		throw new SpellcastManifestError(["manifest root must be an object"], options.sourcePath);
	}

	const issues: string[] = [];
	const name = typeof rawManifest.name === "string" ? rawManifest.name : undefined;
	if (!name || name.trim().length === 0) {
		issues.push("name is required");
	}

	let description: string | undefined;
	if (rawManifest.description !== undefined) {
		if (typeof rawManifest.description !== "string") {
			issues.push("description must be a string when provided");
		} else {
			description = rawManifest.description;
		}
	}

	const entry = typeof rawManifest.entry === "string" ? rawManifest.entry : undefined;
	if (!entry || entry.trim().length === 0) {
		issues.push("entry is required");
	} else if (!isExplicitRelativePath(entry)) {
		issues.push("entry must be an explicit relative path");
	}

	const files = validateFileList(rawManifest.files, issues);
	if (entry && files.length > 0 && !files.includes(entry)) {
		issues.push("entry must be included in files");
	}

	const visibilityRaw = rawManifest.visibility;
	let visibility: SpellcastManifestVisibility = DEFAULT_SPELLCAST_VISIBILITY;
	if (visibilityRaw !== undefined) {
		if (visibilityRaw === "public" || visibilityRaw === "unlisted") {
			visibility = visibilityRaw;
		} else {
			issues.push("visibility must be one of: public, unlisted");
		}
	}

	const validTools = new Set(options.validTools ?? DEFAULT_SPELLCAST_VALID_TOOLS);
	const tools = validateToolList(rawManifest.tools, validTools, issues);

	const autoSyncRaw = rawManifest.auto_sync;
	const auto_sync = autoSyncRaw === undefined ? false : autoSyncRaw;
	if (typeof auto_sync !== "boolean") {
		issues.push("auto_sync must be a boolean when provided");
	}

	if (issues.length > 0) {
		throw new SpellcastManifestError(issues, options.sourcePath);
	}

	return {
		name: name!,
		description,
		entry: entry!,
		files,
		visibility,
		tools,
		auto_sync: auto_sync as boolean,
	};
}

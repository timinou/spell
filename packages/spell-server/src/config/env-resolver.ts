/**
 * Shared environment variable resolution for KDL config files.
 *
 * Extracted from manifest/parser.ts — used by server-parser, channels-parser,
 * and manifest parser. Also provides scanning and validation utilities for
 * the startup env check.
 */

// -- Types --

export interface EnvReference {
	name: string;
	optional: boolean;
	defaultValue?: string | number | boolean;
	type?: "string" | "number" | "boolean";
}

export type ScalarExpectedType = "string" | "number" | "boolean";

/** An env() reference with its source file for reporting. */
export interface EnvReferenceInfo {
	name: string;
	optional: boolean;
	defaultValue?: string | number | boolean;
	type?: ScalarExpectedType;
	/** Which KDL file contained this reference (e.g. "server.kdl") */
	source: string;
}

export interface EnvValidationResult {
	loaded: EnvReferenceInfo[];
	missing: EnvReferenceInfo[];
	defaulted: EnvReferenceInfo[];
}

// -- Parsing --

export function splitEnvTokens(content: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inQuotes = false;

	for (let index = 0; index < content.length; index += 1) {
		const char = content[index];
		if (char === '"' && content[index - 1] !== "\\") {
			inQuotes = !inQuotes;
			current += char;
			continue;
		}
		if (char === "," && !inQuotes) {
			if (current.trim()) {
				tokens.push(current.trim());
			}
			current = "";
			continue;
		}
		current += char;
	}

	if (current.trim()) {
		tokens.push(current.trim());
	}

	return tokens;
}

export function parseDefaultValue(raw: string): string | number | boolean {
	if (raw.startsWith('"') && raw.endsWith('"')) {
		return JSON.parse(raw) as string;
	}
	if (raw === "true") return true;
	if (raw === "false") return false;
	const numeric = Number(raw);
	if (!Number.isNaN(numeric) && raw.trim().length > 0) {
		return numeric;
	}
	return raw;
}

export function parseEnvReference(value: string): EnvReference | null {
	const match = /^env\((.*)\)$/.exec(value.trim());
	if (!match) {
		return null;
	}
	const tokens = splitEnvTokens(match[1]);
	if (tokens.length === 0) {
		throw new Error("env() requires a variable name");
	}
	const envReference: EnvReference = {
		name: tokens[0],
		optional: false,
	};
	for (const token of tokens.slice(1)) {
		if (token === "optional") {
			envReference.optional = true;
			continue;
		}
		if (token.startsWith("default=")) {
			envReference.defaultValue = parseDefaultValue(token.slice("default=".length));
			continue;
		}
		if (token.startsWith("type=")) {
			const typeValue = token.slice("type=".length);
			if (typeValue !== "string" && typeValue !== "number" && typeValue !== "boolean") {
				throw new Error(`Unsupported env() type: ${typeValue}`);
			}
			envReference.type = typeValue;
			continue;
		}
		throw new Error(`Unsupported env() option: ${token}`);
	}
	return envReference;
}

// -- Coercion & Resolution --

export function coerceEnvValue(
	envReference: EnvReference,
	rawValue: string | number | boolean,
	expectedType: ScalarExpectedType,
	pathLabel: string,
): string | number | boolean {
	const targetType = envReference.type ?? expectedType;
	if (targetType === "string") {
		return String(rawValue);
	}
	if (targetType === "number") {
		const numericValue = typeof rawValue === "number" ? rawValue : Number(rawValue);
		if (!Number.isFinite(numericValue)) {
			throw new Error(`${pathLabel} expected env(${envReference.name}) to resolve to a finite number`);
		}
		return numericValue;
	}
	if (typeof rawValue === "boolean") {
		return rawValue;
	}
	if (rawValue === "true") return true;
	if (rawValue === "false") return false;
	throw new Error(`${pathLabel} expected env(${envReference.name}) to resolve to a boolean`);
}

/**
 * Resolve a KDL value that may be an env() reference.
 * Returns the resolved value coerced to expectedType.
 */
export function resolveEnvValue<T extends string | number | boolean>(
	value: unknown,
	expectedType: ScalarExpectedType,
	pathLabel: string,
	env?: Record<string, string | undefined>,
): T {
	if (typeof value === "string") {
		const envReference = parseEnvReference(value);
		if (envReference) {
			const envValue = env?.[envReference.name];
			if (envValue === undefined || envValue === "") {
				if (envReference.defaultValue !== undefined) {
					return coerceEnvValue(envReference, envReference.defaultValue, expectedType, pathLabel) as T;
				}
				if (envReference.optional) {
					throw new Error(
						`${pathLabel} used optional env(${envReference.name}) where a ${expectedType} value is required`,
					);
				}
				throw new Error(`${pathLabel} requires environment variable ${envReference.name}`);
			}
			return coerceEnvValue(envReference, envValue, expectedType, pathLabel) as T;
		}
		if (expectedType === "string") {
			return value as T;
		}
		throw new Error(`${pathLabel} must be a ${expectedType}`);
	}
	if (expectedType === "number") {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			throw new Error(`${pathLabel} must be a finite number`);
		}
		return value as T;
	}
	if (expectedType === "boolean") {
		if (typeof value !== "boolean") {
			throw new Error(`${pathLabel} must be a boolean`);
		}
		return value as T;
	}
	throw new Error(`${pathLabel} must be a ${expectedType}`);
}

/**
 * Resolve a string value that may contain an env() reference.
 * Simpler version for string-only fields (no type coercion needed).
 */
export function resolveEnvString(raw: string, pathLabel: string, env?: Record<string, string | undefined>): string {
	return resolveEnvValue<string>(raw, "string", pathLabel, env);
}

// -- Scanning --

const ENV_REF_PATTERN = /env\(([^)]+)\)/g;
const KDL_COMMENT_LINE = /^\s*\/\//;

/**
 * Scan raw KDL text for env() references without parsing the KDL.
 * Skips KDL comment lines (// ...).
 */
export function scanEnvReferences(text: string, source: string): EnvReferenceInfo[] {
	const refs: EnvReferenceInfo[] = [];
	const seen = new Set<string>();

	for (const line of text.split("\n")) {
		if (KDL_COMMENT_LINE.test(line)) continue;

		for (const match of line.matchAll(ENV_REF_PATTERN)) {
			const inner = match[1].trim();
			const tokens = splitEnvTokens(inner);
			if (tokens.length === 0) continue;

			const name = tokens[0];
			// Deduplicate within the same source file
			if (seen.has(name)) continue;
			seen.add(name);

			let optional = false;
			let defaultValue: string | number | boolean | undefined;
			let type: ScalarExpectedType | undefined;

			for (const token of tokens.slice(1)) {
				if (token === "optional") {
					optional = true;
				} else if (token.startsWith("default=")) {
					defaultValue = parseDefaultValue(token.slice("default=".length));
				} else if (token.startsWith("type=")) {
					const tv = token.slice("type=".length);
					if (tv === "string" || tv === "number" || tv === "boolean") {
						type = tv;
					}
				}
			}

			refs.push({ name, optional, defaultValue, type, source });
		}
	}

	return refs;
}

// -- Validation --

/**
 * Classify env references as loaded, missing, or defaulted
 * based on the current environment.
 */
export function validateEnvReferences(
	refs: EnvReferenceInfo[],
	env: Record<string, string | undefined>,
): EnvValidationResult {
	const loaded: EnvReferenceInfo[] = [];
	const missing: EnvReferenceInfo[] = [];
	const defaulted: EnvReferenceInfo[] = [];

	// Deduplicate by name (keep first occurrence)
	const seen = new Set<string>();

	for (const ref of refs) {
		if (seen.has(ref.name)) continue;
		seen.add(ref.name);

		const value = env[ref.name];
		if (value !== undefined && value !== "") {
			loaded.push(ref);
		} else if (ref.defaultValue !== undefined) {
			defaulted.push(ref);
		} else if (ref.optional) {
			// Optional with no default — treat as defaulted (won't fail)
			defaulted.push(ref);
		} else {
			missing.push(ref);
		}
	}

	return { loaded, missing, defaulted };
}

// -- Formatting --

/**
 * Format a human-readable startup environment report.
 *
 * Shows status of each env reference and, if any are missing,
 * an actionable error message telling the user what to add.
 */
export function formatEnvReport(result: EnvValidationResult, envFilePath: string): string {
	const lines: string[] = [];

	// Status table
	const allRefs = [...result.loaded, ...result.defaulted, ...result.missing];
	if (allRefs.length > 0) {
		lines.push("spell-server: environment check:");
		const maxNameLen = Math.max(...allRefs.map(r => r.name.length));

		for (const ref of result.loaded) {
			lines.push(`  ${ref.name.padEnd(maxNameLen)}  loaded`);
		}
		for (const ref of result.defaulted) {
			const note = ref.defaultValue !== undefined ? ` (default: ${ref.defaultValue})` : " (optional)";
			lines.push(`  ${ref.name.padEnd(maxNameLen)}  loaded${note}`);
		}
		for (const ref of result.missing) {
			lines.push(`  ${ref.name.padEnd(maxNameLen)}  MISSING (required by ${ref.source})`);
		}
	}

	// Actionable error section
	if (result.missing.length > 0) {
		lines.push("");
		lines.push("Error: missing required environment variables:");
		lines.push("");
		const maxNameLen = Math.max(...result.missing.map(r => r.name.length));
		for (const ref of result.missing) {
			lines.push(`  ${ref.name.padEnd(maxNameLen)}  required by ${ref.source}`);
		}
		lines.push("");
		lines.push(`Add to ${envFilePath}:`);
		lines.push("");
		for (const ref of result.missing) {
			lines.push(`  ${ref.name}=`);
		}
	}

	return lines.join("\n");
}

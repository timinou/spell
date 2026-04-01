import * as path from "node:path";
import type { SpellDomain } from "../../../../domain/growth/src/types";

/** Re-export so callers can reference the type without reaching into domain/growth directly. */
export type { SpellDomain };

/**
 * Load and return the SpellDomain manifest for `name`.
 *
 * - 'coding' returns the built-in default without any filesystem I/O.
 * - All other names dynamically import `domain/<name>/manifest.ts` relative
 *   to `cwd`, then validate the manifest has the required shape fields.
 *
 * @throws If the manifest file is missing or fails required-field validation.
 */
export async function loadDomain(name: string, cwd: string): Promise<SpellDomain> {
	if (name === "coding") {
		const mod = await import("../../../../domain/coding/manifest");
		validateManifest(name, mod.default);
		return mod.default as SpellDomain;
	}

	const manifestPath = path.resolve(cwd, "domain", name, "manifest.ts");
	let mod: { default?: unknown };
	try {
		mod = await import(manifestPath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to load domain manifest '${name}' from '${manifestPath}': ${message}`);
	}

	const manifest = mod.default;
	validateManifest(name, manifest);
	return manifest as SpellDomain;
}

/**
 * Assert that `manifest` has the minimum shape required for a SpellDomain.
 * Throws a descriptive error for the first missing or malformed field.
 */
function validateManifest(name: string, manifest: unknown): void {
	const ctx = `Domain manifest '${name}'`;

	if (manifest === null || typeof manifest !== "object") {
		throw new Error(`${ctx} default export must be an object`);
	}

	const m = manifest as Record<string, unknown>;

	if (typeof m.name !== "string" || m.name.length === 0) {
		throw new Error(`${ctx} is missing required string field 'name'`);
	}
	if (m.name !== name) {
		throw new Error(`${ctx} field 'name' must equal '${name}'`);
	}
	if (typeof m.description !== "string") {
		throw new Error(`${ctx} is missing required string field 'description'`);
	}
	if (typeof m.tools !== "object" || m.tools === null) {
		throw new Error(`${ctx} is missing required object field 'tools'`);
	}
	if (!Array.isArray(m.panels)) {
		throw new Error(`${ctx} is missing required array field 'panels'`);
	}
	if (!Array.isArray(m.workspaces)) {
		throw new Error(`${ctx} is missing required array field 'workspaces'`);
	}
	if (m.systemPromptPath !== undefined && typeof m.systemPromptPath !== "string") {
		throw new Error(`${ctx} field 'systemPromptPath' must be a string when provided`);
	}
	if (m.contextFiles !== undefined && !isStringArray(m.contextFiles)) {
		throw new Error(`${ctx} field 'contextFiles' must be an array of strings when provided`);
	}
	if (m.alwaysCanvas !== undefined && typeof m.alwaysCanvas !== "boolean") {
		throw new Error(`${ctx} field 'alwaysCanvas' must be a boolean when provided`);
	}
	if (m.shellQmlPath !== undefined && typeof m.shellQmlPath !== "string") {
		throw new Error(`${ctx} field 'shellQmlPath' must be a string when provided`);
	}
	if (m.modesDir !== undefined && typeof m.modesDir !== "string") {
		throw new Error(`${ctx} field 'modesDir' must be a string when provided`);
	}
	if (m.loopDomains !== undefined && !isStringArray(m.loopDomains)) {
		throw new Error(`${ctx} field 'loopDomains' must be an array of strings when provided`);
	}
	if (m.artifactTypes !== undefined && !isStringArray(m.artifactTypes)) {
		throw new Error(`${ctx} field 'artifactTypes' must be an array of strings when provided`);
	}
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(entry => typeof entry === "string");
}

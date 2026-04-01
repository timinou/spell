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
		// Resolved at bundle time — no dynamic path needed.
		const mod = await import("../../../../domain/coding/manifest");
		return mod.default as SpellDomain;
	}

	const manifestPath = path.resolve(cwd, "domain", name, "manifest.ts");
	let mod: { default?: unknown };
	try {
		mod = await import(manifestPath);
	} catch (err) {
		throw new Error(`loadDomain: could not load manifest for domain '${name}' at '${manifestPath}': ${String(err)}`);
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
	const ctx = `loadDomain: manifest for '${name}'`;

	if (manifest === null || typeof manifest !== "object") {
		throw new Error(`${ctx} default export must be an object`);
	}

	const m = manifest as Record<string, unknown>;

	if (typeof m.name !== "string" || m.name.length === 0) {
		throw new Error(`${ctx} missing required string field 'name'`);
	}
	if (typeof m.description !== "string") {
		throw new Error(`${ctx} missing required string field 'description'`);
	}
	if (typeof m.tools !== "object" || m.tools === null) {
		throw new Error(`${ctx} missing required object field 'tools'`);
	}
	if (!Array.isArray(m.panels)) {
		throw new Error(`${ctx} missing required array field 'panels'`);
	}
	if (!Array.isArray(m.workspaces)) {
		throw new Error(`${ctx} missing required array field 'workspaces'`);
	}
}

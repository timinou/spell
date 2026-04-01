import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { SpellDomain } from "../../../../domain/growth/src/types";

/** Re-export so callers can reference the type without reaching into domain/growth directly. */
export type { SpellDomain };

type DomainSource = "builtin" | "workspace";

type DomainLoaderModule = { default?: unknown };

type LoadedSpellDomain = SpellDomain & {
	rootDir: string;
	source: DomainSource;
};

const BUILTIN_DOMAIN_ROOT = path.resolve(import.meta.dir, "../../../../");

const BUILTIN_DOMAIN_LOADERS: Record<string, () => Promise<DomainLoaderModule>> = {
	coding: () => import("../../../../domain/coding/manifest"),
	growth: () => import("../../../../domain/growth/manifest"),
};

/**
 * Load and return the SpellDomain manifest for `name`.
 *
 * Resolution order:
 * - workspace domain at `domain/<name>/manifest.ts` under `cwd`
 * - built-in domain shipped with Spell (for example `coding`, `growth`)
 *
 * @throws If the workspace manifest exists but cannot be loaded, or if no
 * manifest exists in either the workspace or the built-in registry.
 */
export async function loadDomain(name: string, cwd: string): Promise<SpellDomain> {
	const workspaceManifestPath = path.resolve(cwd, "domain", name, "manifest.ts");
	const workspaceDomain = await loadWorkspaceDomain(name, cwd, workspaceManifestPath);
	if (workspaceDomain) {
		return workspaceDomain;
	}

	const builtinLoader = BUILTIN_DOMAIN_LOADERS[name];
	if (builtinLoader) {
		return await loadBuiltinDomain(name, builtinLoader);
	}

	throw new Error(
		`Failed to load domain manifest '${name}': no workspace manifest at '${workspaceManifestPath}' and no built-in domain with that name`,
	);
}

export function getDomainBaseDir(domainManifest: SpellDomain | undefined, cwd: string): string {
	const rootDir = (domainManifest as { rootDir?: unknown } | undefined)?.rootDir;
	return typeof rootDir === "string" && rootDir.length > 0 ? rootDir : cwd;
}

export function resolveDomainPath(domainManifest: SpellDomain | undefined, cwd: string, filePath: string): string {
	return path.resolve(getDomainBaseDir(domainManifest, cwd), filePath);
}

async function loadWorkspaceDomain(
	name: string,
	cwd: string,
	workspaceManifestPath: string,
): Promise<SpellDomain | null> {
	try {
		const stat = await fs.stat(workspaceManifestPath);
		if (!stat.isFile()) {
			throw new Error(`Workspace domain manifest '${name}' at '${workspaceManifestPath}' is not a file`);
		}
	} catch (error) {
		if (isEnoent(error)) {
			return null;
		}
		throw error;
	}

	const mod = await importManifest(name, workspaceManifestPath, "workspace");
	return finalizeDomain(name, mod.default, cwd, "workspace");
}

async function loadBuiltinDomain(name: string, loader: () => Promise<DomainLoaderModule>): Promise<SpellDomain> {
	let mod: DomainLoaderModule;
	try {
		mod = await loader();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to load built-in domain manifest '${name}': ${message}`);
	}
	return finalizeDomain(name, mod.default, BUILTIN_DOMAIN_ROOT, "builtin");
}

async function importManifest(name: string, manifestPath: string, source: DomainSource): Promise<DomainLoaderModule> {
	try {
		return await import(manifestPath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to load ${source} domain manifest '${name}' from '${manifestPath}': ${message}`);
	}
}

function finalizeDomain(name: string, manifest: unknown, rootDir: string, source: DomainSource): SpellDomain {
	validateManifest(name, manifest);
	return {
		...(manifest as SpellDomain),
		rootDir,
		source,
	} as LoadedSpellDomain;
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

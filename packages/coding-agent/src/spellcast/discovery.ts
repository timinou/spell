import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseSpellcastManifest, type SpellcastManifest } from "./manifest";

export const DEFAULT_SPELLCAST_DISCOVERY_MAX_DEPTH = 3;
export const DEFAULT_SPELLCAST_IGNORED_DIRS = ["node_modules", ".git", ".local"] as const;
export const SPELLCAST_MANIFEST_SUFFIXES = [".spellcast.manifest.yaml", ".spellcast.manifest.yml"] as const;

export interface DiscoveredSpellcastManifest {
	manifestPath: string;
	manifestDir: string;
	manifest: SpellcastManifest;
}

export interface DiscoverSpellcastManifestsOptions {
	maxDepth?: number;
	ignoredDirs?: readonly string[];
}

export interface SpellcastManifestDiscoveryResult {
	manifests: DiscoveredSpellcastManifest[];
	warnings: string[];
}

function isSpellcastManifestFile(name: string): boolean {
	return SPELLCAST_MANIFEST_SUFFIXES.some(suffix => name.endsWith(suffix));
}

export async function discoverSpellcastManifests(
	rootDir: string,
	options: DiscoverSpellcastManifestsOptions = {},
): Promise<SpellcastManifestDiscoveryResult> {
	const maxDepth = options.maxDepth ?? DEFAULT_SPELLCAST_DISCOVERY_MAX_DEPTH;
	const ignored = new Set(options.ignoredDirs ?? DEFAULT_SPELLCAST_IGNORED_DIRS);
	const resolvedRoot = path.resolve(rootDir);

	const manifests: DiscoveredSpellcastManifest[] = [];
	const warnings: string[] = [];

	async function walk(currentDir: string, depth: number): Promise<void> {
		let entries: fs.Dirent[];
		try {
			entries = await fs.readdir(currentDir, { withFileTypes: true });
		} catch (error) {
			warnings.push(`Failed to read directory ${currentDir}: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}

		const sortedEntries = [...entries].sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of sortedEntries) {
			const fullPath = path.join(currentDir, entry.name);
			if (entry.isDirectory()) {
				if (ignored.has(entry.name)) continue;
				if (depth < maxDepth) {
					await walk(fullPath, depth + 1);
				}
				continue;
			}

			if (!(entry.isFile() || entry.isSymbolicLink())) {
				continue;
			}
			if (!isSpellcastManifestFile(entry.name)) {
				continue;
			}

			try {
				const content = await Bun.file(fullPath).text();
				const manifest = parseSpellcastManifest(content, { sourcePath: fullPath });
				manifests.push({
					manifestPath: fullPath,
					manifestDir: path.dirname(fullPath),
					manifest,
				});
			} catch (error) {
				warnings.push(
					`Invalid spellcast manifest at ${fullPath}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	await walk(resolvedRoot, 0);
	manifests.sort((left, right) => left.manifestPath.localeCompare(right.manifestPath));

	return { manifests, warnings };
}

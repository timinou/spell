import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ServiceRegistry } from "./service-registry";

const WELL_KNOWN = new Set(["spell-browser", "spell-browse-mode", "SpellBrowser"]);
const TIMESTAMPED_PATTERN = /^spell-browser-\d+-\d+$/;

export interface OrphanProfile {
	name: string;
	path: string;
	isTimestamped: boolean;
}

export interface CleanupResult {
	orphans: OrphanProfile[];
	deleted: string[];
	skipped: string[];
}

export async function findOrphanedProfiles(options?: {
	registryPath?: string;
	storageRoot?: string;
}): Promise<OrphanProfile[]> {
	const registry = new ServiceRegistry(options?.registryPath);
	const services = await registry.list();
	const referenced = new Set(services.map(s => s.profileStorage));

	const storageRoot =
		options?.storageRoot ?? path.join(os.homedir(), ".local", "share", "omp-qml-bridge", "QtWebEngine");

	let entries: string[];
	try {
		entries = await fs.readdir(storageRoot);
	} catch {
		return [];
	}

	const orphans: OrphanProfile[] = [];
	for (const name of entries) {
		if (WELL_KNOWN.has(name) || referenced.has(name)) continue;
		const fullPath = path.join(storageRoot, name);
		try {
			const stat = await fs.stat(fullPath);
			if (!stat.isDirectory()) continue;
		} catch {
			continue;
		}
		orphans.push({
			name,
			path: fullPath,
			isTimestamped: TIMESTAMPED_PATTERN.test(name),
		});
	}
	return orphans;
}

export async function cleanupProfiles(options: {
	dryRun?: boolean;
	force?: boolean;
	registryPath?: string;
	storageRoot?: string;
}): Promise<CleanupResult> {
	const orphans = await findOrphanedProfiles(options);
	const deleted: string[] = [];
	const skipped: string[] = [];

	if (options.dryRun) {
		return { orphans, deleted: [], skipped: orphans.map(o => o.name) };
	}

	for (const orphan of orphans) {
		if (orphan.isTimestamped || options.force) {
			try {
				await fs.rm(orphan.path, { recursive: true, force: true });
				deleted.push(orphan.name);
			} catch {
				skipped.push(orphan.name);
			}
		} else {
			skipped.push(orphan.name);
		}
	}

	return { orphans, deleted, skipped };
}

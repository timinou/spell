import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@spell/pi-utils";
import type { BundleManifest } from "./types";

const MANIFEST_FILE = "manifest.json";

/** Read cached manifest */
export async function readCachedManifest(cacheDir: string): Promise<BundleManifest | null> {
	try {
		return (await Bun.file(path.join(cacheDir, MANIFEST_FILE)).json()) as BundleManifest;
	} catch (err) {
		if (isEnoent(err)) {
			return null;
		}
		throw err;
	}
}

/** Write manifest to cache */
export async function writeCachedManifest(cacheDir: string, manifest: BundleManifest): Promise<void> {
	await fs.mkdir(cacheDir, { recursive: true });
	await Bun.write(path.join(cacheDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
}

/** Check if cached bundle is still valid (hash matches) */
export async function isCacheValid(cacheDir: string, currentHash: string): Promise<boolean> {
	const cached = await readCachedManifest(cacheDir);
	return cached !== null && cached.hash === currentHash;
}

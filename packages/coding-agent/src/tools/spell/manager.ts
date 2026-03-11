import * as fs from "node:fs/promises";
import * as path from "node:path";
import { APP_NAME, getProjectDir, getToolsDir, logger } from "@oh-my-pi/pi-utils";

const SPELL_REPO = "timinou/kika";
const SPELL_ASSET = "spell-arm64-v8a.apk";
const DOWNLOAD_TIMEOUT_MS = 60_000;
const METADATA_TIMEOUT_MS = 5_000;

const cachedApkPath = path.join(getToolsDir(), "spell.apk");

interface ReleaseAsset {
	name: string;
	browser_download_url: string;
}

interface GithubRelease {
	assets: ReleaseAsset[];
}

export class SpellManager {
	/** Check cache and local build output for an existing APK. */
	async locateApk(): Promise<string | null> {
		// 1. Try the tools cache path.
		try {
			const stat = await fs.stat(cachedApkPath);
			if (stat.size > 0) return cachedApkPath;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}

		// 2. Try local build output under apps/spell/build.
		const buildDir = path.join(getProjectDir(), "apps/spell/build");
		try {
			const entries = await fs.readdir(buildDir, { recursive: true });
			const apk = entries.find(e => e.endsWith(".apk"));
			if (apk) return path.join(buildDir, apk);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}

		return null;
	}

	/** Download APK from GitHub Releases into the tools cache dir. */
	async downloadApk(signal?: AbortSignal): Promise<string> {
		try {
			// Fetch latest release metadata.
			const metaRes = await fetch(`https://api.github.com/repos/${SPELL_REPO}/releases/latest`, {
				headers: { "User-Agent": `${APP_NAME}-coding-agent` },
				signal: AbortSignal.any(
					[AbortSignal.timeout(METADATA_TIMEOUT_MS), signal].filter(Boolean) as AbortSignal[],
				),
			});

			if (!metaRes.ok) {
				throw new Error(`GitHub API error ${metaRes.status}: ${await metaRes.text()}`);
			}

			const release = (await metaRes.json()) as GithubRelease;
			const asset = release.assets.find(a => a.name === SPELL_ASSET);

			if (!asset) {
				const available = release.assets.map((a: ReleaseAsset) => a.name).join(", ") || "(none)";
				throw new Error(`${SPELL_ASSET} not found in latest release. Assets: ${available}`);
			}

			// Download the APK.
			const dlRes = await fetch(asset.browser_download_url, {
				headers: { "User-Agent": `${APP_NAME}-coding-agent` },
				signal: AbortSignal.any(
					[AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), signal].filter(Boolean) as AbortSignal[],
				),
			});

			if (!dlRes.ok) {
				throw new Error(`APK download error ${dlRes.status}: ${await dlRes.text()}`);
			}

			// Bun.write handles parent dir creation automatically.
			await Bun.write(cachedApkPath, dlRes);

			return cachedApkPath;
		} catch (error) {
			logger.error("SpellManager download failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	/** Resolves to local APK path; downloads from GitHub Releases if not cached. */
	async ensureApk(signal?: AbortSignal): Promise<string> {
		const existing = await this.locateApk();
		if (existing) return existing;
		return this.downloadApk(signal);
	}
}

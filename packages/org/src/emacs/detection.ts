import * as fs from "node:fs/promises";
import { logger } from "@oh-my-pi/pi-utils";

export interface EmacsDetection {
	found: boolean;
	path: string | null;
	version: string | null;
	meetsMinimum: boolean;
	socatFound: boolean;
	socatPath: string | null;
	errors: string[];
}

const MIN_VERSION = "29.1";

const COMMON_PATHS = ["/usr/bin/emacs", "/usr/local/bin/emacs", "/opt/homebrew/bin/emacs"];

/**
 * Lexicographic semver comparison — returns negative if a < b, 0 if equal, positive if a > b.
 * Handles missing segments as 0 (e.g. "29" == "29.0").
 */
function compareVersions(a: string, b: string): number {
	const aParts = a.split(".").map(Number);
	const bParts = b.split(".").map(Number);
	const len = Math.max(aParts.length, bParts.length);
	for (let i = 0; i < len; i++) {
		const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** Extract version string from `emacs --version` output. */
function parseVersion(out: string): string | null {
	const match = out.match(/GNU Emacs (\d+\.\d+(?:\.\d+)?)/);
	return match ? match[1] : null;
}

/** Check whether a path exists and is executable without throwing. */
async function isExecutable(p: string): Promise<boolean> {
	try {
		await fs.access(p, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function findEmacsBinary(configuredPath?: string): Promise<string | null> {
	// 1. Caller-supplied path takes precedence.
	if (configuredPath && (await isExecutable(configuredPath))) {
		return configuredPath;
	}

	// 2. PATH lookup via Bun.
	const found = Bun.which("emacs");
	if (found && (await isExecutable(found))) {
		return found;
	}

	// 3. Well-known locations as last resort.
	for (const p of COMMON_PATHS) {
		if (await isExecutable(p)) {
			return p;
		}
	}

	return null;
}

async function findSocatBinary(): Promise<string | null> {
	const found = Bun.which("socat");
	if (found && (await isExecutable(found))) {
		return found;
	}
	return null;
}

/**
 * Detect Emacs and socat on the current system.
 *
 * @param configuredPath - Optional explicit path to the emacs binary from config.
 */
export async function detectEmacs(configuredPath?: string): Promise<EmacsDetection> {
	const errors: string[] = [];

	const emacsPath = await findEmacsBinary(configuredPath);
	if (!emacsPath) {
		errors.push("Emacs not found in PATH or common locations");
		logger.warn("[emacs-detection] Emacs binary not found", { configuredPath });
		return {
			found: false,
			path: null,
			version: null,
			meetsMinimum: false,
			socatFound: false,
			socatPath: null,
			errors,
		};
	}

	// Run `emacs --version` via Bun shell — quiet suppresses stdout echo, nothrow prevents throws.
	let version: string | null = null;
	try {
		const result = await Bun.$`${emacsPath} --version`.quiet().nothrow();
		version = parseVersion(result.stdout.toString("utf-8"));
		if (!version) {
			errors.push("Could not parse Emacs version output");
			logger.warn("[emacs-detection] Could not parse version", { emacsPath });
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		errors.push(`Failed to run emacs --version: ${msg}`);
		logger.warn("[emacs-detection] emacs --version failed", { emacsPath, err: msg });
	}

	let meetsMinimum = false;
	if (version) {
		meetsMinimum = compareVersions(version, MIN_VERSION) >= 0;
		if (!meetsMinimum) {
			const msg = `Emacs ${version} is below minimum ${MIN_VERSION}`;
			errors.push(msg);
			logger.warn(`[emacs-detection] ${msg}`, { version, minimum: MIN_VERSION });
		}
	}

	const socatPath = await findSocatBinary();
	const socatFound = socatPath !== null;
	if (!socatFound) {
		errors.push("socat not found — JSON-RPC transport unavailable");
		logger.warn("[emacs-detection] socat not found");
	}

	logger.debug("[emacs-detection] Detection complete", { emacsPath, version, meetsMinimum, socatFound });

	return {
		found: true,
		path: emacsPath,
		version,
		meetsMinimum,
		socatFound,
		socatPath,
		errors,
	};
}

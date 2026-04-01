import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";

/** Shape of the optional `.spell/domain.json` override file. */
interface DomainOverrideFile {
	domain: string;
}

/**
 * Determine which Spell domain is active for a given working directory.
 *
 * Resolution order:
 * 1. `cliOverride` — explicit flag wins outright.
 * 2. `${cwd}/.spell/domain.json` — workspace-local override.
 * 3. Heuristic: presence of `domain/growth/` directory under cwd → 'growth'.
 * 4. Default: 'coding'.
 */
export async function detectDomain(cwd: string, cliOverride?: string): Promise<string> {
	if (cliOverride) {
		return cliOverride;
	}

	// Workspace-local override file.
	const overridePath = path.join(cwd, ".spell", "domain.json");
	try {
		const raw = await Bun.file(overridePath).text();
		const parsed = JSON.parse(raw) as DomainOverrideFile;
		if (typeof parsed.domain === "string" && parsed.domain.length > 0) {
			return parsed.domain;
		}
		logger.warn(`detectDomain: ${overridePath} missing 'domain' field — falling back to heuristic`);
	} catch (err) {
		if (!isEnoent(err)) {
			// File is present but unreadable or contains invalid JSON — warn and continue.
			logger.warn(`detectDomain: could not read ${overridePath}: ${String(err)}`);
		}
		// File absent is the common case; silently fall through to heuristic.
	}

	// Heuristic: working inside a repo that has a domain/growth/ directory.
	try {
		const stat = await fs.stat(path.join(cwd, "domain", "growth"));
		if (stat.isDirectory()) {
			return "growth";
		}
	} catch {
		// Not present — proceed to default.
	}

	return "coding";
}

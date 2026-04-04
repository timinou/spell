import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";

import { loadSpellKdl } from "../config/spell-kdl";

/** Shape of the optional `.spell/domain.json` override file. */
interface DomainOverrideFile {
	domain: string;
}

function parseDomainOverride(raw: string, overridePath: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid domain override file at '${overridePath}': ${message}`);
	}
	if (parsed === null || typeof parsed !== "object") {
		throw new Error(
			`Invalid domain override file at '${overridePath}': expected an object with a non-empty 'domain' field`,
		);
	}
	const domain = (parsed as DomainOverrideFile).domain?.trim();
	if (!domain) {
		throw new Error(`Invalid domain override file at '${overridePath}': expected a non-empty string field 'domain'`);
	}
	return domain;
}

/**
 * Determine which Spell domain is active for a given working directory.
 *
 * Resolution order:
 * 1. `cliOverride` — explicit flag wins outright.
 * 2. `spell.kdl` `domain` node at project root.
 * 3. `.spell/domain.json` — legacy override (logs deprecation warning).
 * 4. Default: `coding`.
 *
 * @throws If `.spell/domain.json` exists but cannot be parsed or validated.
 */
export async function detectDomain(cwd: string, cliOverride?: string): Promise<string> {
	const trimmedOverride = cliOverride?.trim();
	if (trimmedOverride) {
		return trimmedOverride;
	}

	// 2. Try spell.kdl domain field
	const spellConfig = await loadSpellKdl(cwd);
	if (spellConfig?.domain) return spellConfig.domain;

	// 3. Legacy: .spell/domain.json (with deprecation warning)
	const overridePath = path.join(cwd, ".spell", "domain.json");
	try {
		const raw = await Bun.file(overridePath).text();
		logger.warn("domain.json is deprecated; use spell.kdl instead. Run `spell init` to migrate.");
		return parseDomainOverride(raw, overridePath);
	} catch (error) {
		if (!isEnoent(error)) {
			throw error;
		}
	}

	return "coding";
}

import * as path from "node:path";
import { parse } from "@bgotink/kdl";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";

import { parseSpellKdl } from "../config/spell-kdl";

/**
 * Determine which Spell domain is active for a given working directory.
 *
 * Resolution order:
 * 1. `cliOverride` — explicit flag wins outright.
 * 2. `spell.kdl` `domain` node at project root.
 * 3. Default: `coding`.
 *
 * The legacy `.spell/domain.json` reader was removed in PLAN-311 WAVE 2b
 * after the YAML/JSON → KDL cutover. The one-shot migrator translates
 * pre-existing domain.json into the spell.kdl `domain` node; running this
 * function on a never-migrated source returns the default and ignores any
 * stray domain.json files.
 */
export async function detectDomain(cwd: string, cliOverride?: string): Promise<string> {
	const trimmedOverride = cliOverride?.trim();
	if (trimmedOverride) {
		return trimmedOverride;
	}

	const spellKdlPath = path.join(cwd, "spell.kdl");
	try {
		const spellKdlContent = await Bun.file(spellKdlPath).text();
		// Pre-validate KDL syntax before calling parseSpellKdl. parseSpellKdl
		// returns an empty config for both broken KDL and valid KDL with no
		// domain. Broken KDL → default; valid KDL with no domain → default.
		try {
			parse(spellKdlContent);
		} catch {
			return "coding";
		}

		const spellConfig = await parseSpellKdl(spellKdlContent);
		if (spellConfig.domain) return spellConfig.domain;
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("spell-kdl: failed to load spell.kdl", {
				filePath: spellKdlPath,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	// Orphan-detection warning: if a legacy .spell/domain.json exists but
	// nothing in spell.kdl supplies a domain, the user is silently falling
	// back to the default. Preserve the pre-WAVE-2b deprecation warning so
	// users who skipped the migrator (--no-migrate, declined dialog, or
	// .migration-skipped marker) discover the issue. One stat call on the
	// rare default path.
	const legacyPath = path.join(cwd, ".spell", "domain.json");
	try {
		await Bun.file(legacyPath).text();
		logger.warn(
			"spell-kdl: found orphan .spell/domain.json but no `domain` in spell.kdl; defaulting to 'coding'. Run the migrator (Settings.init prompts) or add `domain \"...\"` to spell.kdl manually.",
			{ legacyPath },
		);
	} catch {
		// missing or unreadable — no warning needed.
	}

	return "coding";
}

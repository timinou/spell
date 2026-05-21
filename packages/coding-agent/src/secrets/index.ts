import { logger } from "@oh-my-pi/pi-utils";
import { settings } from "../config/settings";
import type { SecretEntry } from "./obfuscator";
import { compileSecretRegex } from "./regex";

export { obfuscateMessages, type SecretEntry, SecretObfuscator } from "./obfuscator";

/**
 * Load secret obfuscation entries from spell.kdl.
 *
 * Sources from the unified `secrets` block via Settings, which reads from
 * (in precedence order) <cwd>/.local/spell.kdl, <cwd>/spell.kdl, then
 * ~/.config/spell/spell.kdl. The migrator (src/migration/) translates legacy
 * ~/.spell/agent/secrets.yml and <cwd>/.spell/secrets.yml on first launch.
 *
 * @param _cwd Unused; preserved for callsite compatibility.
 * @param _agentDir Unused; preserved for callsite compatibility.
 */
export async function loadSecrets(_cwd: string, _agentDir: string): Promise<SecretEntry[]> {
	void _cwd;
	void _agentDir;
	// Per-tier read — cross-tier additive semantics. Pre-WAVE-2 `loadSecrets`
	// merged user-tier + project-tier YAML files; the default `settings.get`
	// would replace arrays wholesale (project array wins, user secrets
	// invisible). Restore the legacy contract by walking each tier and
	// deduping by content.
	const tiers = settings.getPerTier("secrets");
	const seen = new Set<string>();
	const entries: SecretEntry[] = [];
	// Order: user → project → local → session. Each layer adds entries the
	// previous layers did not contribute. "Higher" tiers don't OVERRIDE the
	// lower ones — every configured obfuscation pattern applies.
	let layerIdx = 0;
	for (const layer of [tiers.user, tiers.project, tiers.local, tiers.session]) {
		layerIdx++;
		if (!Array.isArray(layer)) continue;
		for (let i = 0; i < layer.length; i++) {
			const entry = layer[i];
			if (!validateEntry(entry, i)) continue;
			if (seen.has(entry.content)) continue;
			seen.add(entry.content);
			entries.push({
				type: entry.type,
				content: entry.content,
				mode: entry.mode ?? "obfuscate",
				replacement: entry.replacement,
				flags: entry.flags,
			});
		}
	}
	void layerIdx;
	return entries;
}

/** Minimum env var value length to consider as a secret. */
const MIN_ENV_VALUE_LENGTH = 8;

/** Env var name patterns that indicate secret values. */
const SECRET_ENV_PATTERNS = /(?:KEY|SECRET|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE|OAUTH)(?:_|$)/i;

/** Collect environment variable values that look like secrets. */
export function collectEnvSecrets(): SecretEntry[] {
	const entries: SecretEntry[] = [];
	const seen = new Set<string>();
	for (const [name, value] of Object.entries(process.env)) {
		if (!value || value.length < MIN_ENV_VALUE_LENGTH) continue;
		if (!SECRET_ENV_PATTERNS.test(name)) continue;
		if (seen.has(value)) continue;
		seen.add(value);
		entries.push({ type: "plain", content: value, mode: "obfuscate" });
	}
	return entries;
}

function validateEntry(entry: unknown, index: number): entry is SecretEntry {
	if (entry === null || typeof entry !== "object") {
		logger.warn(`secrets[${index}]: entry must be an object`);
		return false;
	}
	const e = entry as Record<string, unknown>;
	if (e.type !== "plain" && e.type !== "regex") {
		logger.warn(`secrets[${index}]: type must be "plain" or "regex"`);
		return false;
	}
	if (typeof e.content !== "string" || e.content.length === 0) {
		logger.warn(`secrets[${index}]: content must be a non-empty string`);
		return false;
	}
	if (e.mode !== undefined && e.mode !== "obfuscate" && e.mode !== "replace") {
		logger.warn(`secrets[${index}]: mode must be "obfuscate" or "replace"`);
		return false;
	}
	if (e.replacement !== undefined && typeof e.replacement !== "string") {
		logger.warn(`secrets[${index}]: replacement must be a string`);
		return false;
	}
	if (e.flags !== undefined && typeof e.flags !== "string") {
		logger.warn(`secrets[${index}]: flags must be a string`);
		return false;
	}
	if (e.type === "regex") {
		try {
			compileSecretRegex(e.content as string, e.flags as string | undefined);
		} catch (error) {
			logger.warn(`secrets[${index}]: invalid regex pattern`, {
				pattern: e.content,
				error: String(error),
			});
			return false;
		}
	}
	return true;
}

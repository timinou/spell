/**
 * Translate a legacy YAML/JSON/KDL settings file into the canonical KDL
 * destination, then rename the original to `*.migrated-YYYY-MM-DD.bak`.
 *
 * The translation pipeline is uniform across all three formats:
 *
 *   read source → parse into RawObj → flatten to dotted SettingPath map
 *   → writeKdlSettings(dest, map)  → rename source to *.bak
 *
 * Unknown keys (anything without a KDL mapping in SETTINGS_SCHEMA) are
 * silently dropped. That is intentional: this is a one-shot migration of
 * Spell-shaped config, not a generic data converter.
 */

import * as fs from "node:fs/promises";
import { YAML } from "bun";
import { logger } from "@oh-my-pi/pi-utils";
import { KDL_SETTINGS_MAP } from "../config/kdl-settings-map";
import { writeKdlSettings } from "../config/kdl-writer";
import { loadKdlSettings } from "../config/kdl-reader";
import type { SettingPath } from "../config/settings-schema";
import type { Finding } from "./detect";

/** Plain nested object produced by YAML/JSON parsers. */
type RawObj = Record<string, unknown>;

/** Outcome of a single translation. */
export interface TranslateResult {
	source: string;
	dest: string;
	/** Number of settings successfully written to the destination. */
	keysWritten: number;
	/** Path of the renamed backup file. */
	bakPath: string;
}

/**
 * Format today's date as YYYY-MM-DD for the backup filename. Pure to keep
 * tests deterministic when `now` is supplied.
 */
export function backupSuffix(now: Date = new Date()): string {
	const y = now.getUTCFullYear();
	const m = String(now.getUTCMonth() + 1).padStart(2, "0");
	const d = String(now.getUTCDate()).padStart(2, "0");
	return `.migrated-${y}-${m}-${d}.bak`;
}

/**
 * Pick a destination .bak path that doesn't already exist. Adds a numeric
 * suffix when needed. Idempotency is the detector's job — this just avoids
 * clobbering same-day duplicates from prior partial runs.
 */
async function pickBakPath(source: string, now: Date): Promise<string> {
	const base = source + backupSuffix(now);
	let candidate = base;
	let counter = 1;
	while (true) {
		try {
			await fs.access(candidate);
			candidate = base.replace(/\.bak$/, `.${counter}.bak`);
			counter++;
		} catch {
			return candidate;
		}
	}
}

/**
 * Lookup a dotted path inside a parsed object. Tries the flat-key path first
 * (e.g. `obj["theme.dark"]`) then descends nested segments (`obj.theme.dark`).
 * Returns undefined if not present.
 */
function lookupPath(obj: RawObj, path: string): unknown {
	if (path in obj) return obj[path];
	const segments = path.split(".");
	let cur: unknown = obj;
	for (const seg of segments) {
		if (cur === null || cur === undefined || typeof cur !== "object" || Array.isArray(cur)) {
			return undefined;
		}
		cur = (cur as Record<string, unknown>)[seg];
		if (cur === undefined) return undefined;
	}
	return cur;
}

/** Discriminated result of parsing a legacy source. */
type ParseResult =
	/** Parse succeeded and produced a record (may be empty {}). */
	| { kind: "ok"; data: RawObj }
	/** File is valid but represents no record (empty doc, top-level scalar/array). */
	| { kind: "empty" }
	/** Parser raised — keep the source for the user to inspect, retry next launch. */
	| { kind: "error" };

/**
 * Parse a legacy source file according to its declared format.
 *
 * Distinguishes three outcomes so the caller can decide whether to rename to
 * `.bak`:
 *   - `ok`     : translatable record (may have zero recognized keys)
 *   - `empty`  : file is well-formed but contributes nothing — still .bak
 *   - `error`  : actual parse failure — do NOT .bak, let user fix and retry
 */
async function parseSource(source: string, format: Finding["format"]): Promise<ParseResult> {
	const text = await fs.readFile(source, "utf8");
	if (text.trim().length === 0) return { kind: "empty" };
	try {
		switch (format) {
			case "yaml": {
				const parsed = YAML.parse(text) as unknown;
				if (parsed === undefined || parsed === null) return { kind: "empty" };
				return isRecord(parsed) ? { kind: "ok", data: parsed } : { kind: "empty" };
			}
			case "json": {
				const parsed = JSON.parse(text) as unknown;
				if (parsed === undefined || parsed === null) return { kind: "empty" };
				return isRecord(parsed) ? { kind: "ok", data: parsed } : { kind: "empty" };
			}
			case "kdl": {
				// loadKdlSettings throws on parse error; success may be {}.
				const parsed = (await loadKdlSettings(source)) as RawObj;
				return { kind: "ok", data: parsed };
			}
		}
	} catch (err) {
		logger.warn("migration: failed to parse source (keeping for retry)", {
			source,
			format,
			err: String(err),
		});
		return { kind: "error" };
	}
}

function isRecord(value: unknown): value is RawObj {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Flatten a RawObj into a Map of SettingPath → leaf value, scoped to known
 * SETTINGS_SCHEMA paths via KDL_SETTINGS_MAP. Unknown keys are dropped.
 */
export function flattenToSettingsMap(obj: RawObj): Map<string, unknown> {
	const out = new Map<string, unknown>();
	for (const key of Object.keys(KDL_SETTINGS_MAP)) {
		const value = lookupPath(obj, key);
		if (value === undefined) continue;
		// applySetting handles Record-valued leaves like modelRoles natively;
		// no further flattening needed.
		out.set(key as SettingPath, value);
	}
	return out;
}

/**
 * Translate ONE legacy source into KDL at its destination, then rename the
 * source to a dated `.bak` sibling. Idempotency is ensured by the detector
 * (which never returns a finding whose source already has a `.bak` sibling).
 *
 * Throws on unrecoverable IO errors. On parse failure, returns null and
 * leaves the source untouched.
 */
export async function translateFinding(finding: Finding, now: Date = new Date()): Promise<TranslateResult | null> {
	const parsed = await parseSource(finding.source, finding.format);

	// Real parse failure — leave source alone so the user can fix it; the
	// detector will re-prompt next launch.
	if (parsed.kind === "error") return null;

	const changes = parsed.kind === "ok" ? flattenToSettingsMap(parsed.data) : new Map<string, unknown>();

	if (parsed.kind === "empty" || changes.size === 0) {
		logger.warn("migration: source contributed no recognized settings; renaming to .bak", {
			source: finding.source,
		});
	}

	// Only touch destination KDL when we have something to write.
	if (changes.size > 0) {
		await writeKdlSettings(finding.dest, changes);
	}

	const bakPath = await pickBakPath(finding.source, now);
	await fs.rename(finding.source, bakPath);

	return {
		source: finding.source,
		dest: finding.dest,
		keysWritten: changes.size,
		bakPath,
	};
}

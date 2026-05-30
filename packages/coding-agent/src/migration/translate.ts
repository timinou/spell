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
import { logger } from "@spell/pi-utils";
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
	/** Parse succeeded and produced a non-record value (array, scalar). Only valid when finding.topLevelKey is set. */
	| { kind: "raw"; data: unknown }
	/** File is valid but represents no value (empty doc). */
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
				if (isRecord(parsed)) return { kind: "ok", data: parsed };
				return { kind: "raw", data: parsed };
			}
			case "json": {
				const parsed = JSON.parse(text) as unknown;
				if (parsed === undefined || parsed === null) return { kind: "empty" };
				if (isRecord(parsed)) return { kind: "ok", data: parsed };
				return { kind: "raw", data: parsed };
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

	let changes: Map<string, unknown>;
	if (finding.topLevelKey) {
		// Whole-file (or extracted-key) mode: a designated SettingPath receives
		// the entire parsed value, OR — if topLevelSourceKey is set — a nested
		// key extracted from the parsed record. Used for legacy files whose
		// shape doesn't fit the dotted-key flattener:
		//   secrets.yml → topLevelKey="secrets", whole array
		//   mcp.json   → topLevelKey="mcp.servers", extract "mcpServers"
		changes = new Map<string, unknown>();
		let effectiveParsed: ParseResult = parsed;
		if (finding.topLevelSourceKey && parsed.kind === "ok") {
			const extracted = (parsed.data as Record<string, unknown>)[finding.topLevelSourceKey];
			if (extracted === undefined || extracted === null) {
				effectiveParsed = { kind: "empty" };
			} else if (typeof extracted === "object" && !Array.isArray(extracted)) {
				effectiveParsed = { kind: "ok", data: extracted as Record<string, unknown> };
			} else if (Array.isArray(extracted)) {
				effectiveParsed = { kind: "raw", data: extracted };
			} else {
				effectiveParsed = { kind: "raw", data: extracted };
			}
		}
		let incoming = await coerceTopLevel(finding.topLevelKey, effectiveParsed, finding.source);
		// Schema-shape normalization for known top-level keys with legacy
		// permissive shapes. Applied AFTER extraction so the normalizer sees
		// the host map directly, not the wrapping {hosts:{...}} record.
		// Without this, legacy permissive forms (port as string, compat as
		// 'yes', `key` alias) survive into KDL but are then dropped by the
		// readers — a one-way silent data loss since the legacy file has
		// already been renamed to .bak.
		if (
			finding.topLevelKey === "ssh.hosts" &&
			incoming !== undefined &&
			!Array.isArray(incoming) &&
			typeof incoming === "object"
		) {
			incoming = normalizeLegacySshHosts(incoming as Record<string, unknown>);
		}
		if (incoming !== undefined) {
			const existing = await readExistingTopLevel(finding.dest, finding.topLevelKey);
			const merged = mergeTopLevelValue(finding.topLevelKey, existing, incoming);
			changes.set(finding.topLevelKey, merged);
		}
	} else if (parsed.kind === "ok") {
		changes = flattenToSettingsMap(parsed.data);
	} else {
		changes = new Map<string, unknown>();
	}

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

/**
 * Shape-check the parsed top-level value before writing it as `topLevelKey`.
 * Returns the validated value, or undefined if the shape is invalid for the
 * declared key (e.g. a top-level scalar where an array was expected).
 */
async function coerceTopLevel(
	key: string,
	parsed: ParseResult,
	source: string,
): Promise<unknown[] | Record<string, unknown> | undefined> {
	if (parsed.kind === "empty" || parsed.kind === "error") return undefined;
	const data = parsed.kind === "ok" ? parsed.data : parsed.data;

	// Known mergeable-array keys.
	const ARRAY_KEYS = new Set(["secrets"]);
	// Known mergeable-record keys (object whose properties dedupe by key).
	const RECORD_KEYS = new Set(["mcp.servers", "ssh.hosts"]);

	if (ARRAY_KEYS.has(key)) {
		if (!Array.isArray(data)) {
			logger.warn("migration: source has wrong shape for top-level key (expected array)", {
				key,
				source,
			});
			return undefined;
		}
		return data as unknown[];
	}

	if (RECORD_KEYS.has(key)) {
		if (!data || typeof data !== "object" || Array.isArray(data)) {
			logger.warn("migration: source has wrong shape for top-level key (expected record)", {
				key,
				source,
			});
			return undefined;
		}
		return data as Record<string, unknown>;
	}

	// Unknown top-level key: best-effort pass-through.
	if (Array.isArray(data)) return data as unknown[];
	if (data && typeof data === "object") return data as Record<string, unknown>;
	logger.warn("migration: unknown top-level key with non-record value; skipping", { key, source });
	return undefined;
}

/** Read the existing top-level array value from a destination KDL file. */
async function readExistingTopLevel(dest: string, key: string): Promise<unknown[] | Record<string, unknown>> {
	try {
		const raw = await loadKdlSettings(dest);
		// Schema keys may be dotted (e.g. "mcp.servers"). loadKdlSettings
		// produces nested objects, so split the dotted path and walk.
		const segments = key.split(".");
		let cur: unknown = raw;
		for (const seg of segments) {
			if (cur === null || cur === undefined || typeof cur !== "object" || Array.isArray(cur)) {
				cur = undefined;
				break;
			}
			cur = (cur as Record<string, unknown>)[seg];
		}
		if (Array.isArray(cur)) return cur;
		if (cur && typeof cur === "object") return cur as Record<string, unknown>;
		return [];
	} catch {
		return [];
	}
}

/**
 * Union an existing array with incoming entries. Dedupe by the appropriate
 * uniqueness key for the SettingPath in question.
 *
 * For `secrets`: dedupe by `entry.content` (an identical secret pattern
 * doesn't need to appear twice). For other keys: dedupe by deep equality on
 * JSON serialization (cheap fallback).
 */
/**
 * Union an existing top-level value with incoming data. Dedupe by the
 * appropriate uniqueness key for the SettingPath in question.
 *
 * - `secrets` (array): dedupe by `entry.content`.
 * - `mcp.servers` (record): merge by server name; existing entries win on
 *   conflict (manual edits to spell.kdl beat re-migrated legacy mcp.json).
 * - other arrays: dedupe by JSON equality.
 * - other records: shallow union; existing wins on conflict.
 */
function mergeTopLevelValue(
	key: string,
	existing: unknown[] | Record<string, unknown>,
	incoming: unknown[] | Record<string, unknown>,
): unknown[] | Record<string, unknown> {
	if (key === "secrets" && Array.isArray(existing) && Array.isArray(incoming)) {
		const seen = new Set<string>();
		const result: unknown[] = [];
		for (const layer of [existing, incoming]) {
			for (const entry of layer) {
				if (!entry || typeof entry !== "object") continue;
				const content = (entry as { content?: unknown }).content;
				if (typeof content !== "string" || content.length === 0) continue;
				if (seen.has(content)) continue;
				seen.add(content);
				result.push(entry);
			}
		}
		return result;
	}

	if ((key === "mcp.servers" || key === "ssh.hosts") && !Array.isArray(existing) && !Array.isArray(incoming)) {
		// Manual edits to spell.kdl take precedence over re-migrated entries.
		return { ...(incoming as Record<string, unknown>), ...(existing as Record<string, unknown>) };
	}

	if (Array.isArray(existing) && Array.isArray(incoming)) {
		const seenJson = new Set<string>();
		const result: unknown[] = [];
		for (const layer of [existing, incoming]) {
			for (const entry of layer) {
				const json = JSON.stringify(entry);
				if (seenJson.has(json)) continue;
				seenJson.add(json);
				result.push(entry);
			}
		}
		return result;
	}

	if (!Array.isArray(existing) && !Array.isArray(incoming)) {
		return { ...(incoming as Record<string, unknown>), ...(existing as Record<string, unknown>) };
	}

	// Shape mismatch: incoming wins (existing was a different shape, likely
	// from a prior schema). The reader will warn if the resulting KDL is
	// internally inconsistent.
	return incoming;
}


/**
 * Normalize legacy ssh.json host entries into the canonical schema shape
 * before persisting to spell.kdl. Without this, permissive forms (port as
 * string, compat as 'yes'/'no', `key` alias) survive the round-trip into
 * KDL but are then dropped by `readSshHosts`, since the legacy `ssh.json`
 * has already been renamed to .bak — a one-way silent data loss.
 */
function normalizeLegacySshHosts(hosts: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [name, raw] of Object.entries(hosts)) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			result[name] = raw;
			continue;
		}
		const entry = raw as Record<string, unknown>;
		const out: Record<string, unknown> = {};

		// host / hostname
		if (typeof entry.host === "string") out.host = entry.host;
		else if (typeof entry.hostname === "string") out.host = entry.hostname;

		// username / user
		if (typeof entry.username === "string") out.username = entry.username;
		else if (typeof entry.user === "string") out.username = entry.user;

		// port: number | numeric string
		if (entry.port !== undefined && entry.port !== null) {
			if (typeof entry.port === "number" && Number.isFinite(entry.port)) {
				out.port = entry.port;
			} else if (typeof entry.port === "string") {
				const n = Number.parseInt(entry.port, 10);
				if (Number.isFinite(n)) out.port = n;
			}
		}

		// compat: boolean | yes/no/true/false string | 0/1
		if (entry.compat !== undefined && entry.compat !== null) {
			if (typeof entry.compat === "boolean") out.compat = entry.compat;
			else if (typeof entry.compat === "string") {
				const v = entry.compat.trim().toLowerCase();
				if (v === "true" || v === "1" || v === "yes") out.compat = true;
				else if (v === "false" || v === "0" || v === "no") out.compat = false;
			}
		}

		// keyPath alias: legacy ssh.json accepted both `keyPath` and `key`
		if (typeof entry.keyPath === "string") out.keyPath = entry.keyPath;
		else if (typeof entry.key === "string") out.keyPath = entry.key;

		// description (pass-through)
		if (typeof entry.description === "string") out.description = entry.description;

		result[name] = out;
	}
	return result;
}


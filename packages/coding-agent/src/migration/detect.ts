/**
 * Detect legacy Spell config files that need migration to KDL.
 *
 * Self-contained: imports only pi-utils path helpers and the standard
 * library. No coupling to the broader settings/discovery codebase.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, getProjectAgentDir, getProjectKdlPath, getUserKdlPath, isEnoent } from "@oh-my-pi/pi-utils";

/** Format of a legacy source file. */
export type LegacyFormat = "kdl" | "yaml" | "json";

/** A detected legacy file that can be migrated. */
export interface Finding {
	/** Absolute path to the source file on disk. */
	source: string;
	/** Format of the source content. */
	format: LegacyFormat;
	/** Absolute destination path where translated KDL should be written. */
	dest: string;
	/** Tier the destination belongs to. */
	tier: "user" | "project";
	/** Size of the source file in bytes (for dialog display). */
	bytes: number;
	/**
	 * When set, the entire parsed file content (array or record) becomes the
	 * value of this `SettingPath` in the destination KDL. Used for legacy
	 * files whose top-level shape doesn't match the dotted-key flattener:
	 *   - secrets.yml — a top-level YAML array; `topLevelKey: "secrets"`
	 * When unset, the translator flattens the parsed object against
	 * KDL_SETTINGS_MAP (the common case).
	 */
	topLevelKey?: string;
}

/** Options for the scan. */
export interface DetectOptions {
	/** Project root; defaults to current process cwd. */
	cwd?: string;
	/** Override agent dir (test-only; defaults to env-resolved). */
	agentDir?: string;
	/** Override user KDL destination (test-only). */
	userKdlDest?: string;
	/** Override project KDL destination (test-only). */
	projectKdlDest?: string;
	/** Skip-forever marker file. When present, detect returns an empty list. */
	skipMarkerPath?: string;
}

/**
 * Result of {@link detectLegacyConfig}.
 *
 * - `findings` is empty when nothing needs migration.
 * - `skipped` lists sources that had a `.migrated-*.bak` sibling and were
 *   ignored (returned for logging only; never the same as `findings`).
 */
export interface DetectResult {
	findings: Finding[];
	skipped: string[];
}

/** Filename pattern produced by the migrator after a successful translation. */
const BAK_PATTERN = /\.migrated-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.bak$/;

async function fileSize(p: string): Promise<number | null> {
	try {
		const st = await fs.stat(p);
		if (!st.isFile()) return null;
		return st.size;
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

/** Returns true if any sibling file of `source` matches the .migrated-*.bak pattern. */
async function hasBakSibling(source: string): Promise<boolean> {
	const dir = path.dirname(source);
	const base = path.basename(source);
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
	const prefix = `${base}.migrated-`;
	for (const entry of entries) {
		if (entry.startsWith(prefix) && BAK_PATTERN.test(entry.slice(base.length))) {
			return true;
		}
	}
	return false;
}

interface Candidate {
	source: string;
	format: LegacyFormat;
	dest: string;
	tier: "user" | "project";
	topLevelKey?: string;
}

/**
 * Scan the filesystem for legacy Spell config files needing migration.
 *
 * Returned findings are deterministic and exclude:
 *   - missing files
 *   - sources whose destination equals the source path (no-op moves)
 *   - sources with a `.migrated-*.bak` sibling already present (idempotency)
 *
 * The migrator is one-shot: once a source has been processed and its `.bak`
 * sibling exists, this function will never report it again.
 */
export async function detectLegacyConfig(options: DetectOptions = {}): Promise<DetectResult> {
	const cwd = options.cwd ?? process.cwd();
	const userDest = options.userKdlDest ?? getUserKdlPath();
	const projectDest = options.projectKdlDest ?? getProjectKdlPath(cwd);

	// Resolve user/project agent dirs without mutating global state.
	const userAgentDir = options.agentDir ?? getAgentDir();
	const userBase = path.dirname(userAgentDir); // ~/.spell
	const projectBase = getProjectAgentDir(cwd); // <cwd>/.spell
	// Legacy user KDL derived from the SUPPLIED agent dir, not the global
	// resolver — lets tests pin scopes without touching real $HOME.
	const legacyUserKdl = path.join(userBase, "spell.kdl");

	if (options.skipMarkerPath) {
		try {
			await fs.stat(options.skipMarkerPath);
			// Marker exists → user said "skip forever".
			return { findings: [], skipped: [] };
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
	}

	const candidates: Candidate[] = [
		// USER tier
		{ source: legacyUserKdl, format: "kdl", dest: userDest, tier: "user" },
		{ source: path.join(userAgentDir, "config.yml"), format: "yaml", dest: userDest, tier: "user" },
		{ source: path.join(userAgentDir, "settings.json"), format: "json", dest: userDest, tier: "user" },
		{
			source: path.join(userAgentDir, "secrets.yml"),
			format: "yaml",
			dest: userDest,
			tier: "user",
			topLevelKey: "secrets",
		},
		// PROJECT tier
		{ source: path.join(projectBase, "spell.kdl"), format: "kdl", dest: projectDest, tier: "project" },
		{ source: path.join(projectBase, "settings.json"), format: "json", dest: projectDest, tier: "project" },
		{
			source: path.join(projectBase, "agent", "config.yml"),
			format: "yaml",
			dest: projectDest,
			tier: "project",
		},
		{
			source: path.join(projectBase, "secrets.yml"),
			format: "yaml",
			dest: projectDest,
			tier: "project",
			topLevelKey: "secrets",
		},
		// Legacy .spell/domain.json — record with single `domain` key. Flattens
		// to the schema's `domain` setting via the standard flattener (no
		// topLevelKey needed).
		{
			source: path.join(projectBase, "domain.json"),
			format: "json",
			dest: projectDest,
			tier: "project",
		},
	];

	const findings: Finding[] = [];
	const skipped: string[] = [];

	for (const c of candidates) {
		// No-op moves: never propose `source == dest`.
		if (path.resolve(c.source) === path.resolve(c.dest)) continue;

		const size = await fileSize(c.source);
		if (size === null) continue;

		if (await hasBakSibling(c.source)) {
			skipped.push(c.source);
			continue;
		}

		findings.push({
			source: c.source,
			format: c.format,
			dest: c.dest,
			tier: c.tier,
			bytes: size,
			...(c.topLevelKey ? { topLevelKey: c.topLevelKey } : {}),
		});
	}

	return { findings, skipped };
}

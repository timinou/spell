import * as path from "node:path";

/**
 * Detects when a relative path supplied to a tool already contains the
 * session-cwd's trailing path segments — the bug pattern that produces
 * `apps/foo/apps/foo/...` nesting.
 *
 * Mechanism: agents read AGENTS.md / plans / specs that address files
 * from the project (often git-toplevel) root, but the harness's session
 * cwd is one or more levels deeper. The agent faithfully passes the
 * project-rooted path, `path.resolve(cwd, p)` silently double-prefixes,
 * and the success message echoes back the input string — so the agent
 * has no feedback signal to detect the miss.
 *
 * The match is segment-aligned: we only fire when the cwd ends with
 * exactly the same path-segment sequence that the relative path starts
 * with, never on partial-segment substring overlap (so cwd `/x/srcs` +
 * path `src/foo.ts` does not false-positive).
 *
 * Absolute inputs are excluded — the caller is unambiguously addressing
 * a specific location.
 *
 * @returns the longest segment-overlap descriptor, or null when no
 *   duplication is detected.
 */
export interface CwdPrefixDuplication {
	/** Number of path segments that overlap between cwd-tail and path-head. */
	overlap: number;
	/** The duplicated prefix as a path string (e.g. "apps/hotelcomm"). */
	duplicatedPrefix: string;
	/** The supplied path with the duplicated prefix stripped — what the
	 * caller almost certainly meant. Empty when the entire path is the
	 * duplicated prefix (degenerate case). */
	strippedPath: string;
}

export function detectCwdPrefixDuplication(cwd: string, relPath: string): CwdPrefixDuplication | null {
	if (path.isAbsolute(relPath)) return null;
	// Anchored navigation (./, ../) signals the caller is reasoning about
	// cwd-relative location explicitly; do not second-guess.
	if (relPath.startsWith(".")) return null;

	const cwdSegs = cwd.split(path.sep).filter(Boolean);
	const pathSegs = relPath.split(/[\\/]/).filter(Boolean);
	if (cwdSegs.length === 0 || pathSegs.length === 0) return null;

	// Find longest k such that cwdSegs.slice(-k) deepEquals pathSegs.slice(0, k).
	// k must leave at least one segment in the stripped path (else the
	// duplication descriptor would point at an empty target).
	const maxK = Math.min(cwdSegs.length, pathSegs.length - 1);
	for (let k = maxK; k >= 1; k--) {
		let match = true;
		for (let i = 0; i < k; i++) {
			if (cwdSegs[cwdSegs.length - k + i] !== pathSegs[i]) {
				match = false;
				break;
			}
		}
		if (match) {
			return {
				overlap: k,
				duplicatedPrefix: pathSegs.slice(0, k).join("/"),
				strippedPath: pathSegs.slice(k).join("/"),
			};
		}
	}
	return null;
}

/**
 * Formats a uniform diagnostic message for the duplication guard.
 * Kept here so create / edit / future tools share identical wording.
 */
export function formatCwdPrefixDuplicationMessage(
	suppliedPath: string,
	cwd: string,
	dup: CwdPrefixDuplication,
): string {
	return (
		`Path "${suppliedPath}" appears to include the cwd prefix "${dup.duplicatedPrefix}". ` +
		`Session cwd is ${cwd}. ` +
		`Pass "${dup.strippedPath}" (relative to cwd) or an absolute path. ` +
		`Paths resolve from cwd, not from project / git root.`
	);
}

/**
 * Decision taken by `resolveCwdRelativePath`.
 *
 * - `no-overlap`: no duplication detected; path resolved against cwd as-is.
 * - `kept-nested`: duplication detected, but on-disk evidence (nested parent
 *   or nested file exists) suggests the caller meant the literal nested path;
 *   we keep it and emit an info-level warning.
 * - `coalesced`: duplication detected, on-disk evidence is consistent with the
 *   bug pattern (nested parent / file does not exist, stripped sibling does or
 *   neither exists); we strip the duplicated prefix and emit a strong warning.
 * - `degenerate`: the entire path equals the duplicated prefix (e.g. cwd ends
 *   with `apps/foo` and path is `apps/foo`); coalescing would leave an empty
 *   target. Callers must reject.
 */
export type CwdResolutionDecision = "no-overlap" | "kept-nested" | "coalesced" | "degenerate";

export interface ResolvedCwdRelativePath {
	/** Final absolute path the caller should use. Empty when degenerate. */
	path: string;
	/** Cwd-relative path corresponding to `path` (for echoing back to agent). */
	relative: string;
	decision: CwdResolutionDecision;
	/** Present when `decision !== "no-overlap"` — the original duplication descriptor. */
	dup?: CwdPrefixDuplication;
	/** Human-readable warning when coalescing or kept-nested; null for `no-overlap` and `degenerate`. */
	warning: string | null;
}

export interface ResolveCwdRelativePathOptions {
	/** "file" (default): existence check looks at the target file OR its parent dir. "dir": only parent dir. Used by edit on non-create ops where the target file must exist. */
	mode?: "file" | "dir";
	/**
	 * Injected fs-exists predicate (for tests). Defaults to node:fs sync exists.
	 * Sync because tool entry points are already async and a single sync stat
	 * is cheaper than threading an awaited helper through the guard.
	 */
	exists?: (p: string) => boolean;
}

/**
 * Single source of truth for the BUG-358/360 cwd-prefix duplication decision.
 * Combines detection, on-disk disambiguation, and message formatting.
 *
 * Callers that previously used `path.isAbsolute(p) ? p : path.resolve(cwd, p)`
 * with naive semantics should switch to this helper, surface the returned
 * `warning` in their tool result text, and use `resolved.path` for fs work.
 */
export function resolveCwdRelativePath(
	cwd: string,
	suppliedPath: string,
	options: ResolveCwdRelativePathOptions = {},
): ResolvedCwdRelativePath {
	// Absolute / dot-anchored paths skip the guard entirely.
	if (path.isAbsolute(suppliedPath) || suppliedPath.startsWith(".")) {
		const abs = path.isAbsolute(suppliedPath) ? suppliedPath : path.resolve(cwd, suppliedPath);
		return {
			path: abs,
			relative: path.relative(cwd, abs) || suppliedPath,
			decision: "no-overlap",
			warning: null,
		};
	}

	const dup = detectCwdPrefixDuplication(cwd, suppliedPath);
	if (!dup) {
		const abs = path.resolve(cwd, suppliedPath);
		// When cwd is nested inside a project (e.g. cwd=packages/coding-agent),
		// agents pass paths relative to the project/git root. The cwd-relative
		// resolution produces a path that doesn't exist. Walk up from cwd to
		// find the nearest ancestor containing the target path.
		const exists = options.exists ?? defaultExists;
		if (!exists(abs) && !exists(path.dirname(abs))) {
			const projectPath = resolveFromProjectRoot(cwd, suppliedPath, exists);
			if (projectPath) {
				return {
					path: projectPath,
					relative: path.relative(cwd, projectPath) || suppliedPath,
					decision: "project-root",
					warning: null,
				};
			}
		}
		return { path: abs, relative: suppliedPath, decision: "no-overlap", warning: null };
	}

	// Degenerate: path equals the duplicated prefix; strip leaves nothing.
	if (!dup.strippedPath) {
		return {
			path: "",
			relative: suppliedPath,
			decision: "degenerate",
			dup,
			warning: `Path "${suppliedPath}" equals the cwd-tail prefix "${dup.duplicatedPrefix}"; cannot resolve to a valid target.`,
		};
	}

	const nested = path.resolve(cwd, suppliedPath);
	const stripped = path.resolve(cwd, dup.strippedPath);
	const exists = options.exists ?? defaultExists;
	const mode = options.mode ?? "file";

	// Disambiguation: prefer literal-nested interpretation only when on-disk
	// evidence supports it (the nested target itself, or its parent dir, exists).
	const nestedEvidence =
		mode === "file" ? exists(nested) || exists(path.dirname(nested)) : exists(path.dirname(nested));
	if (nestedEvidence) {
		const evidencePath = mode === "file" && exists(nested) ? nested : path.dirname(nested);
		return {
			path: nested,
			relative: suppliedPath,
			decision: "kept-nested",
			dup,
			warning:
				`Path "${suppliedPath}" overlaps cwd-tail "${dup.duplicatedPrefix}". ` +
				`Kept literal interpretation because "${path.relative(cwd, evidencePath)}" exists on disk; ` +
				`if you meant the cwd-relative path, pass "${dup.strippedPath}".`,
		};
	}

	// No nested evidence → coalesce. This is the bug pattern.
	return {
		path: stripped,
		relative: dup.strippedPath,
		decision: "coalesced",
		dup,
		warning:
			`Path "${suppliedPath}" included cwd-tail prefix "${dup.duplicatedPrefix}" — ` +
			`auto-stripped to "${dup.strippedPath}". ` +
			`Tool paths resolve from cwd (${cwd}), not from project / git root. ` +
			`Pass "${dup.strippedPath}" next time to avoid this warning.`,
	};
}

/**
 * Walk up from `cwd` toward the filesystem root, looking for a directory
 * that contains `suppliedPath`. Returns the first match (up to 4 levels up),
 * or null. Used when the cwd-relative path doesn't exist on disk — the agent
 * likely passed a project-root-relative path.
 */
function resolveFromProjectRoot(
	cwd: string,
	suppliedPath: string,
	exists: (p: string) => boolean,
): string | null {
	let dir = cwd;
	for (let i = 0; i < 4; i++) {
		const candidate = path.resolve(dir, suppliedPath);
		if (exists(candidate) || exists(path.dirname(candidate))) {
			return candidate;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

// Lazy fs import to keep the pure detector cheap to import in non-fs contexts.
let _existsSync: ((p: string) => boolean) | null = null;
function defaultExists(p: string): boolean {
	if (!_existsSync) {
		const fs = require("node:fs") as typeof import("node:fs");
		_existsSync = (q: string) => fs.existsSync(q);
	}
	return _existsSync(p);
}

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
 * - `project-root`: no duplication, the cwd-relative target did not exist, but
 *   an ancestor of cwd (up to the git/project root) does contain it; we resolve
 *   against that ancestor. No warning — this is the expected
 *   project-root-relative read pattern for nested-cwd sessions.
 * - `unanchored-new`: no duplication; a brand-new NESTED write whose first path
 *   segment does not exist under cwd but DOES exist as a sibling project (peer
 *   of cwd, or in an ancestor up to the project root). The cross-project leak
 *   shape (cwd=/code/ora/verse + write `rv/data/x.json` while /code/ora/rv is a
 *   sibling project): the file silently materialises in the wrong tree. We
 *   still resolve against cwd (no hard block — paths are cwd-relative by
 *   contract) but emit a strong warning naming the sibling so the agent gets
 *   the feedback signal that was previously missing.
 */
export type CwdResolutionDecision =
	| "no-overlap"
	| "kept-nested"
	| "coalesced"
	| "degenerate"
	| "project-root"
	| "unanchored-new";

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
	/**
	 * Absolute path of the owning project / git root, when known. Bounds the
	 * `unanchored-new` sibling-collision walk: ancestors are inspected only up
	 * to `projectRoot`. When omitted, the walk is capped by hop count alone
	 * (still catches the common case where the sibling project is a peer of cwd,
	 * e.g. cwd=/code/ora/verse + write `rv/...` while /code/ora/rv exists).
	 */
	projectRoot?: string;
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
		const isBrandNew = !exists(abs) && !exists(path.dirname(abs));
		if (isBrandNew) {
			const projectPath = resolveFromProjectRoot(cwd, suppliedPath, exists);
			if (projectPath) {
				return {
					path: projectPath,
					relative: path.relative(cwd, projectPath) || suppliedPath,
					decision: "project-root",
					warning: null,
				};
			}
			// Cross-project leak shape (BUG-029 family): a brand-new NESTED write
			// whose first path segment names a directory that exists as a PEER of
			// cwd (a sibling project) — the agent almost certainly meant that
			// sibling project, not a new same-named subdir under cwd. Example:
			//   cwd=/code/ora/verse, write `rv/data/todos.json`
			//   /code/ora/rv exists (sibling project) → agent meant /code/ora/rv
			//   path.resolve drops it at /code/ora/verse/rv/... (wrong tree) and the
			//   success message echoes the input — the silent cross-project leak.
			// We resolve against cwd anyway (no hard block — paths are cwd-relative
			// by contract) but emit a strong feedback warning so the agent
			// self-corrects with an absolute path next turn.
			//
			// Precision guards (avoid false positives on ordinary scaffolding):
			//  - only NESTED writes (>= 2 segments): the leak signature is always
			//    `project/subpath/file`; a bare new top-level file is ordinary.
			//  - the sibling dir must actually EXIST: a genuinely-new `feature/`
			//    dir under cwd has no peer collision and is never flagged.
			const segs = suppliedPath.split(/[\\/]/).filter(Boolean);
			const firstSeg = segs[0];
			const siblingDir = firstSeg ? siblingProjectCollision(cwd, firstSeg, options.projectRoot, exists) : null;
			if (segs.length >= 2 && firstSeg && siblingDir) {
				return {
					path: abs,
					relative: suppliedPath,
					decision: "unanchored-new",
					warning:
						`Path "${suppliedPath}" resolved to ${abs}, but "${firstSeg}" also exists as a sibling project at ${siblingDir}. ` +
						`Tool paths resolve from cwd (${cwd}), NOT from a project name — if you meant the sibling project, pass an absolute path ` +
						`(e.g. ${path.join(siblingDir, segs.slice(1).join("/"))}). ` +
						`If a new "${firstSeg}/" dir under cwd is intended, ignore this note.`,
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
 * Detect the cross-project confusion shape: the agent wrote `<firstSeg>/...`
 * relative to `cwd`, but `<firstSeg>` does NOT exist under cwd while a
 * directory of the same name DOES exist as a sibling (peer of cwd) or in an
 * ancestor up to `projectRoot`. That is the BUG-029 signature — the agent
 * meant the sibling project, not a new same-named subdir under cwd.
 *
 * Returns the absolute path of the colliding sibling directory when the shape
 * matches, else null. Bounded walk (cwd's parent → projectRoot, capped at 8
 * hops); existence probed via the injected predicate so tests stay hermetic.
 *
 * Conservative by construction — fires ONLY when:
 *  - `cwd/<firstSeg>` does not exist (no valid local interpretation), AND
 *  - some ancestor dir `A` (A ≠ cwd) has `A/<firstSeg>` existing.
 * A genuinely-new `feature/` dir under cwd (no peer of that name) never fires.
 */
function siblingProjectCollision(
	cwd: string,
	firstSeg: string,
	projectRoot: string | undefined,
	exists: (p: string) => boolean,
): string | null {
	// A valid local dir means the cwd-relative interpretation is unambiguous.
	if (exists(path.join(cwd, firstSeg))) return null;

	let dir = path.dirname(cwd);
	for (let i = 0; i < 8; i++) {
		if (dir === cwd) break;
		const candidate = path.join(dir, firstSeg);
		if (exists(candidate)) return candidate;
		// Stop once we've inspected projectRoot, or would step above it / hit fs root.
		if (projectRoot && dir === projectRoot) break;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		if (projectRoot && !isPathInside(projectRoot, parent)) break;
		dir = parent;
	}
	return null;
}

/**
 * True when `inner` is `outer` or a descendant of it. Segment-aware so
 * `/a/bc` is NOT considered inside `/a/b`.
 */
function isPathInside(outer: string, inner: string): boolean {
	if (outer === inner) return true;
	const rel = path.relative(outer, inner);
	return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
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

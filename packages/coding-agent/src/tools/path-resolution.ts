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

import { spawnSync } from "child_process";

/**
 * A snapshot of the git working-tree state at a point in time.
 * Used as the before-image for the commit gate: the gate passes when the live
 * HEAD has advanced past this baseline's `head` (see
 * `gate-verification.detectHeadAdvanced`).
 */
export interface GitBaseline {
	/** Resolved HEAD commit SHA (40 hex chars). */
	head: string;
	/** ISO-8601 timestamp when the baseline was captured. */
	capturedAt: string;
	/** Absolute path of the repository root. */
	repoRoot: string;
}

/**
 * Run a git command synchronously inside `cwd`.
 * Returns stdout trimmed on success, or null when the command fails (non-zero exit,
 * signal, or spawn error). stderr is intentionally discarded so callers can surface
 * a truthful unavailable/null result instead of fabricated clean state.
 */
function gitSync(args: string[], cwd: string): string | null {
	try {
		const result = spawnSync("git", args, {
			cwd,
			encoding: "utf8",
			// Avoid inheriting the parent environment's GIT_DIR etc.
			env: { ...process.env },
		});
		if (result.status !== 0 || result.error) return null;
		return (result.stdout as string).trim();
	} catch {
		return null;
	}
}

/**
 * Resolve the git working-tree root for `cwd`, or null when `cwd` is not
 * inside a git repository (or git is unavailable). Used by the system
 * prompt to surface cwd vs project-root asymmetry so the agent does not
 * silently double-prefix paths against the session cwd.
 */
export function getGitToplevelSync(cwd: string): string | null {
	return gitSync(["rev-parse", "--show-toplevel"], cwd);
}

/**
 * Capture a git baseline for `cwd`.
 * Returns null when `cwd` is not inside a git repo or HEAD cannot be resolved
 * (e.g. empty repo with no commits, detached HEAD pointing at an unborn branch).
 */
export async function captureGitBaseline(cwd: string): Promise<GitBaseline | null> {
	// Resolve the repo root first — confirms we are inside a git repo.
	const repoRoot = gitSync(["rev-parse", "--show-toplevel"], cwd);
	if (!repoRoot) return null;

	// Resolve HEAD. Fails on repos with no commits.
	const head = gitSync(["rev-parse", "HEAD"], repoRoot);
	if (!head || head.length !== 40) return null;

	return {
		head,
		capturedAt: new Date().toISOString(),
		repoRoot,
	};
}

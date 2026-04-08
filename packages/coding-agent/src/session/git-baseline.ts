import { spawnSync } from "child_process";

/**
 * A snapshot of the git working-tree state at a point in time.
 * Used as the before-image for later diff computation.
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
 * Structured diff between a baseline and the current working-tree state.
 */
export interface GitBaselineDiff {
	/** Whether any observable change exists relative to the baseline. */
	hasChanges: boolean;
	/** Files that were added, modified, or deleted since the baseline. */
	changedFiles: string[];
	/** True when HEAD has advanced past the baseline commit. */
	headAdvanced: boolean;
	/** Current HEAD SHA at the time of comparison. */
	currentHead: string;
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

function parseStatusChangedFiles(statusOutput: string): string[] {
	return statusOutput
		.split("\n")
		.map(line => line.trimEnd())
		.filter(Boolean)
		.map(line => {
			const payload = line.replace(/^.{1,2}\s+/, "").trim();
			const renameTarget = payload.split(" -> ").at(-1)?.trim();
			return renameTarget && renameTarget.length > 0 ? renameTarget : payload;
		})
		.filter(Boolean);
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

/**
 * Compare the current working-tree state against a previously captured baseline.
 * Returns null when the repo or HEAD can no longer be resolved; callers must treat
 * that as unavailable evidence rather than a clean tree.
 */
export async function compareGitBaseline(cwd: string, baseline: GitBaseline): Promise<GitBaselineDiff | null> {
	const repoRoot = gitSync(["rev-parse", "--show-toplevel"], cwd);
	if (!repoRoot) return null;

	const currentHead = gitSync(["rev-parse", "HEAD"], repoRoot);
	if (!currentHead || currentHead.length !== 40) return null;

	const committedDiffOutput = gitSync(
		["diff", "--name-only", `${baseline.head}..${currentHead}`, "--diff-filter=ACDMRT"],
		repoRoot,
	);
	if (committedDiffOutput === null) return null;

	const statusOutput = gitSync(["status", "--porcelain", "--untracked-files=all"], repoRoot);
	if (statusOutput === null) return null;

	const changedFiles = Array.from(
		new Set([...committedDiffOutput.split("\n").filter(Boolean), ...parseStatusChangedFiles(statusOutput)]),
	).sort();
	const headAdvanced = currentHead !== baseline.head;

	return {
		hasChanges: changedFiles.length > 0 || headAdvanced,
		changedFiles,
		headAdvanced,
		currentHead,
	};
}

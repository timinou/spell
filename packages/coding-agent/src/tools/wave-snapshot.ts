import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

export interface WaveSnapshotRef {
	planId: string;
	waveNumber: number;
	ref: string;
	commit: string;
}

export interface CreateWaveSnapshotResult {
	created: boolean;
	ref?: string;
	commit?: string;
	warning?: string;
}

async function runGit(
	cwd: string,
	args: string[],
	env?: Record<string, string | undefined>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	return { exitCode, stdout, stderr };
}

async function isGitRepo(cwd: string): Promise<boolean> {
	const result = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	return result.exitCode === 0 && result.stdout.trim() === "true";
}

async function getHeadCommit(cwd: string): Promise<string | null> {
	const result = await runGit(cwd, ["rev-parse", "HEAD"]);
	if (result.exitCode !== 0) return null;
	const commit = result.stdout.trim();
	return commit.length > 0 ? commit : null;
}

async function getTreeStatus(cwd: string): Promise<{ clean: boolean; head: string | null }> {
	const head = await getHeadCommit(cwd);
	if (!head) return { clean: false, head: null };
	const status = await runGit(cwd, ["status", "--porcelain", "--untracked-files=all"]);
	if (status.exitCode !== 0) return { clean: false, head };
	return { clean: status.stdout.trim().length === 0, head };
}

async function getGitDir(cwd: string): Promise<string | null> {
	const result = await runGit(cwd, ["rev-parse", "--git-dir"]);
	if (result.exitCode !== 0) return null;
	const gitDir = result.stdout.trim();
	return gitDir.length > 0 ? path.resolve(cwd, gitDir) : null;
}

async function createCommitFromWorkingTree(cwd: string, head: string, ref: string): Promise<string | null> {
	const gitDir = await getGitDir(cwd);
	if (!gitDir) return null;
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-wave-snapshot-"));
	const tempIndex = path.join(tempDir, "index");
	try {
		const realIndex = path.join(gitDir, "index");
		await fs.copyFile(realIndex, tempIndex).catch(async error => {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await fs.writeFile(tempIndex, "");
		});
		const env = { GIT_INDEX_FILE: tempIndex };
		const add = await runGit(cwd, ["add", "-A", "--", "."], env);
		if (add.exitCode !== 0) return null;
		const tree = await runGit(cwd, ["write-tree"], env);
		if (tree.exitCode !== 0) return null;
		const treeId = tree.stdout.trim();
		if (!treeId) return null;
		const commit = await runGit(
			cwd,
			["commit-tree", treeId, "-p", head, "-m", `spell wave boundary snapshot ${ref}`],
			env,
		);
		if (commit.exitCode !== 0) return null;
		const commitId = commit.stdout.trim();
		return commitId.length > 0 ? commitId : null;
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

export async function createWaveSnapshot(
	cwd: string,
	planId: string,
	waveNumber: number,
): Promise<CreateWaveSnapshotResult> {
	if (!(await isGitRepo(cwd))) {
		return { created: false, warning: "Git repository unavailable; skipping wave snapshot" };
	}

	const ref = `refs/spell/plan/${planId}/wave-${waveNumber}`;
	const existing = await runGit(cwd, ["rev-parse", ref]);
	if (existing.exitCode === 0) {
		const commit = existing.stdout.trim();
		return { created: false, ref, commit: commit || undefined };
	}

	const { clean, head } = await getTreeStatus(cwd);
	if (!head) {
		return { created: false, warning: "Git repository unavailable; skipping wave snapshot" };
	}

	const commit = clean ? head : await createCommitFromWorkingTree(cwd, head, ref);
	if (!commit) {
		return { created: false, warning: "Failed to create wave snapshot" };
	}

	const update = await runGit(cwd, ["update-ref", ref, commit]);
	return update.exitCode === 0
		? { created: true, ref, commit }
		: { created: false, warning: "Failed to create wave snapshot" };
}

export async function listPlanSnapshots(cwd: string, planId: string): Promise<WaveSnapshotRef[]> {
	if (!(await isGitRepo(cwd))) return [];
	const prefix = `refs/spell/plan/${planId}/`;
	const result = await runGit(cwd, ["for-each-ref", "--format=%(refname):%(objectname)", prefix]);
	if (result.exitCode !== 0) return [];
	return result.stdout
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean)
		.map(line => {
			const [ref, commit] = line.split(":");
			const match = /wave-(\d+)$/.exec(ref);
			return match ? { planId, waveNumber: Number(match[1]), ref, commit } : null;
		})
		.filter((value): value is WaveSnapshotRef => value !== null)
		.sort((a, b) => a.waveNumber - b.waveNumber);
}

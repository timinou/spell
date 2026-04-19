import { spawn } from "node:child_process";

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

function runGit(cwd: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return new Promise(resolve => {
		const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", chunk => (stdout += chunk));
		child.stderr.on("data", chunk => (stderr += chunk));
		child.on("close", code => resolve({ exitCode: code ?? 0, stdout, stderr }));
	});
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
	const status = await runGit(cwd, ["status", "--porcelain"]);
	if (status.exitCode !== 0) return { clean: false, head };
	return { clean: status.stdout.trim().length === 0, head };
}

async function listExistingRefs(cwd: string): Promise<string[]> {
	const result = await runGit(cwd, ["for-each-ref", "--format=%(refname)"]);
	if (result.exitCode !== 0) return [];
	return result.stdout
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean)
		.filter(ref => ref.startsWith("refs/spell/plan/"));
}

async function createCommitFromWorkingTree(cwd: string): Promise<string | null> {
	const add = await runGit(cwd, ["add", "-A"]);
	if (add.exitCode !== 0) return null;
	const commit = await runGit(cwd, ["commit", "-m", "spell-wave-snapshot", "--allow-empty"]);
	if (commit.exitCode !== 0) return null;
	const head = await getHeadCommit(cwd);
	if (!head) return null;
	const restore = await runGit(cwd, ["reset", "--hard", "HEAD~1"]);
	return restore.exitCode === 0 ? head : null;
}

export async function createWaveSnapshot(cwd: string, planId: string, waveNumber: number): Promise<CreateWaveSnapshotResult> {
	if (!(await isGitRepo(cwd))) {
		return { created: false, warning: "Git repository unavailable; skipping wave snapshot" };
	}

	const ref = `refs/spell/plan/${planId}/wave-${waveNumber}`;
	if ((await listExistingRefs(cwd)).includes(ref)) {
		const existing = await runGit(cwd, ["rev-parse", ref]);
		return existing.exitCode === 0
			? { created: false, ref, commit: existing.stdout.trim() || undefined }
			: { created: false, ref };
	}

	const { clean, head } = await getTreeStatus(cwd);
	if (!head) {
		return { created: false, warning: "Git repository unavailable; skipping wave snapshot" };
	}

	if (clean) {
		const update = await runGit(cwd, ["update-ref", ref, head]);
		return update.exitCode === 0 ? { created: true, ref, commit: head } : { created: false, warning: "Failed to create wave snapshot" };
	}

	const commit = await createCommitFromWorkingTree(cwd);
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
	const result = await runGit(cwd, ["for-each-ref", "--format=%(refname):%(objectname)"]);
	if (result.exitCode !== 0) return [];
	const prefix = `refs/spell/plan/${planId}/`;
	return result.stdout
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.startsWith(prefix))
		.map(line => {
			const [ref, commit] = line.split(":");
			const match = /wave-(\d+)$/.exec(ref);
			return match ? { planId, waveNumber: Number(match[1]), ref, commit } : null;
		})
		.filter((value): value is WaveSnapshotRef => value !== null)
		.sort((a, b) => a.waveNumber - b.waveNumber);
}

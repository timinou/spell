import { $ } from "bun";

export async function createLoopWorktree(
	cwd: string,
	loopId: string,
	targetDir: string,
): Promise<{ branch: string; path: string }> {
	const branch = `loop/${loopId}`;
	const result = await $`git worktree add ${targetDir} -b ${branch}`.cwd(cwd).quiet().nothrow();
	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString().trim();
		throw new Error(`Failed to create worktree for loop ${loopId}: ${stderr}`);
	}
	return { branch, path: targetDir };
}

export async function removeLoopWorktree(cwd: string, worktreePath: string): Promise<void> {
	const result = await $`git worktree remove ${worktreePath} --force`.cwd(cwd).quiet().nothrow();
	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString().trim();
		throw new Error(`Failed to remove worktree at ${worktreePath}: ${stderr}`);
	}
}

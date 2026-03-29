import { $ } from "bun";

export async function createLoopWorktree(
	cwd: string,
	loopId: string,
	targetDir: string,
): Promise<{ branch: string; path: string }> {
	const branch = `loop/${loopId}`;
	await $`git worktree add ${targetDir} -b ${branch}`.cwd(cwd).quiet().nothrow();
	return { branch, path: targetDir };
}

export async function removeLoopWorktree(cwd: string, worktreePath: string): Promise<void> {
	await $`git worktree remove ${worktreePath} --force`.cwd(cwd).quiet().nothrow();
}

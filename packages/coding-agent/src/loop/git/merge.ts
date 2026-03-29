import { $ } from "bun";

export async function mergeLoopBranch(
	cwd: string,
	branch: string,
): Promise<{ ok: boolean; conflictArtifact?: string }> {
	const result = await $`git merge ${branch}`.cwd(cwd).quiet().nothrow();
	if (result.exitCode === 0) {
		return { ok: true };
	}
	return { ok: false, conflictArtifact: result.text().trim() };
}

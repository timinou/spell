import { $ } from "bun";

export async function ensureCleanGitTree(cwd: string): Promise<{ ok: boolean; message?: string }> {
	const result = await $`git status --porcelain`.cwd(cwd).quiet().nothrow();
	if (result.exitCode !== 0) {
		return { ok: true, message: "Git repository unavailable; skipping dirty-tree check" };
	}
	const output = result.text().trim();
	if (!output) {
		return { ok: true };
	}
	return { ok: false, message: "Loop start rejected: repository has uncommitted changes" };
}

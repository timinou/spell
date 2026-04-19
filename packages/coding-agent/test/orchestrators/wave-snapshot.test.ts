import { afterEach, describe, expect, it, mock } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createWaveSnapshot, listPlanSnapshots } from "../../src/orchestrators/fluid/wave-snapshot";

async function initRepo(): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "wave-snapshot-"));
	await $`git init`.cwd(dir).quiet();
	await writeFile(path.join(dir, "file.txt"), "base\n");
	await $`git add -A`.cwd(dir).quiet();
	await $`git commit -m init`.cwd(dir).quiet();
	return dir;
}

afterEach(() => {
	mock.restore();
});

describe("wave snapshot", () => {
	it("creates a ref at HEAD for a clean tree", async () => {
		const repo = await initRepo();
		try {
			const result = await createWaveSnapshot(repo, "PLAN-1", 1);
			expect(result.created).toBe(true);
			expect(result.ref).toBe("refs/spell/plan/PLAN-1/wave-1");
			expect(result.commit).toBeDefined();

			const head = (await $`git rev-parse HEAD`.cwd(repo).quiet().text()).trim();
			const ref = (await $`git rev-parse refs/spell/plan/PLAN-1/wave-1`.cwd(repo).quiet().text()).trim();
			expect(ref).toBe(head);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("creates a snapshot commit for a dirty tree and stores it without advancing the plan ref to HEAD", async () => {
		const repo = await initRepo();
		try {
			await writeFile(path.join(repo, "file.txt"), "base\nchange\n");
			const headBefore = (await $`git rev-parse HEAD`.cwd(repo).quiet().text()).trim();

			const result = await createWaveSnapshot(repo, "PLAN-2", 2);
			expect(result.created).toBe(true);
			expect(result.ref).toBe("refs/spell/plan/PLAN-2/wave-2");
			expect(result.commit).toBeDefined();

			const headAfter = (await $`git rev-parse HEAD`.cwd(repo).quiet().text()).trim();
			expect(headAfter).toBe(headBefore);

			const ref = (await $`git rev-parse refs/spell/plan/PLAN-2/wave-2`.cwd(repo).quiet().text()).trim();
			expect(ref).toBe(result.commit);
			expect(ref).not.toBe(headBefore);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("skips non-git directories with a warning", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "wave-snapshot-non-git-"));
		try {
			const result = await createWaveSnapshot(dir, "PLAN-3", 1);
			expect(result.created).toBe(false);
			expect(result.warning).toContain("Git repository unavailable");
			expect(await listPlanSnapshots(dir, "PLAN-3")).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("suppresses duplicate creation when the ref already exists", async () => {
		const repo = await initRepo();
		try {
			const first = await createWaveSnapshot(repo, "PLAN-4", 1);
			expect(first.created).toBe(true);

			await writeFile(path.join(repo, "file.txt"), "base\nsecond\n");
			const second = await createWaveSnapshot(repo, "PLAN-4", 1);
			expect(second.created).toBe(false);
			expect(second.ref).toBe(first.ref);
			expect(second.commit).toBe(first.commit);

			const snapshots = await listPlanSnapshots(repo, "PLAN-4");
			expect(snapshots).toEqual([
				{
					planId: "PLAN-4",
					waveNumber: 1,
					ref: "refs/spell/plan/PLAN-4/wave-1",
					commit: first.commit!,
				},
			]);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});
});

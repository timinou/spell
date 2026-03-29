import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { formatLoopCheckpointMessage } from "../../src/loop/git/checkpoint";
import { ensureCleanGitTree } from "../../src/loop/git/dirty-check";
import { detectSpecDrift, snapshotSpecFiles } from "../../src/loop/git/drift";
import { recommendWorktreeIsolation } from "../../src/loop/git/isolation-advisor";
import { createLoopWorktree, removeLoopWorktree } from "../../src/loop/git/worktree";
import { LoopManager } from "../../src/loop/loop-manager";

describe("loop git integration", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "loop-git-"));
		await $`git init`.cwd(cwd).quiet().nothrow();
		await $`git config user.email test@example.com`.cwd(cwd).quiet().nothrow();
		await $`git config user.name Test User`.cwd(cwd).quiet().nothrow();
		await Bun.write(path.join(cwd, "tracked.txt"), "one\n");
		await $`git add tracked.txt`.cwd(cwd).quiet().nothrow();
		await $`git commit -m init`.cwd(cwd).quiet().nothrow();
	});

	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
	});

	it("rejects dirty trees and formats checkpoint messages", async () => {
		expect(await ensureCleanGitTree(cwd)).toEqual({ ok: true });
		await Bun.write(path.join(cwd, "tracked.txt"), "two\n");
		const dirty = await ensureCleanGitTree(cwd);
		expect(dirty.ok).toBe(false);
		expect(formatLoopCheckpointMessage("LOOP-1", 2)).toBe("loop(LOOP-1): iteration 2 checkpoint");
	});

	it("detects spec drift and overlapping paths", async () => {
		const specPath = path.join(cwd, "spec.org");
		await Bun.write(specPath, "spec\n");
		const snapshot = await snapshotSpecFiles([specPath]);
		expect(await detectSpecDrift(snapshot)).toEqual([]);
		await Bun.write(specPath, "changed\n");
		expect(await detectSpecDrift(snapshot)).toEqual([specPath]);
		expect(recommendWorktreeIsolation(["a.ts", "b.ts"], ["c.ts", "b.ts"])).toBe(true);
	});
});

describe("loop worktree lifecycle", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "loop-wt-"));
		await $`git init`.cwd(cwd).quiet().nothrow();
		await $`git config user.email test@example.com`.cwd(cwd).quiet().nothrow();
		await $`git config user.name Test`.cwd(cwd).quiet().nothrow();
		await Bun.write(path.join(cwd, "f.txt"), "x");
		await $`git add . && git commit -m init`.cwd(cwd).quiet().nothrow();
	});

	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
	});

	it("createLoopWorktree creates a branch and directory", async () => {
		const targetDir = path.join(cwd, "wt-test");
		const result = await createLoopWorktree(cwd, "LOOP-WT", targetDir);
		expect(result.branch).toBe("loop/LOOP-WT");
		const stat = await fs.stat(targetDir);
		expect(stat.isDirectory()).toBe(true);
		// Verify branch exists
		const branches = await $`git branch`.cwd(cwd).quiet().nothrow();
		expect(branches.text()).toContain("loop/LOOP-WT");
		// Cleanup
		await removeLoopWorktree(cwd, targetDir);
	});

	it("removeLoopWorktree removes directory", async () => {
		const targetDir = path.join(cwd, "wt-rm");
		await createLoopWorktree(cwd, "LOOP-RM", targetDir);
		await removeLoopWorktree(cwd, targetDir);
		const exists = await fs.stat(targetDir).then(
			() => true,
			() => false,
		);
		expect(exists).toBe(false);
	});

	it("E2E: start loop with useWorktree=true, verify branch, kill removes worktree", async () => {
		const settings = { getModelRole: (r: string) => (r === "review" ? "anthropic/claude-sonnet-4-6" : undefined) };
		const manager = new LoopManager({ cwd, settings });
		const loop = await manager.start({ name: "wt-e2e", domains: [], useWorktree: true });
		expect(loop.worktreePath).toBeDefined();
		expect(loop.gitAvailable).toBe(true);
		// Verify worktree directory exists
		const stat = await fs.stat(loop.worktreePath!);
		expect(stat.isDirectory()).toBe(true);
		// Kill should remove worktree
		await manager.kill(loop.id);
		const exists = await fs.stat(loop.worktreePath!).then(
			() => true,
			() => false,
		);
		expect(exists).toBe(false);
	});

	it("useWorktree=true with gitAvailable=false skips without error", async () => {
		const noGitDir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-no-git-wt-"));
		try {
			const settings = { getModelRole: (r: string) => (r === "review" ? "anthropic/claude-sonnet-4-6" : undefined) };
			const manager = new LoopManager({ cwd: noGitDir, settings });
			const loop = await manager.start({ name: "no-git-wt", domains: [], useWorktree: true });
			expect(loop.gitAvailable).toBe(false);
			expect(loop.worktreePath).toBeUndefined();
		} finally {
			await fs.rm(noGitDir, { recursive: true, force: true });
		}
	});
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { formatLoopCheckpointMessage } from "../../src/loop/git/checkpoint";
import { ensureCleanGitTree } from "../../src/loop/git/dirty-check";
import { detectSpecDrift, snapshotSpecFiles } from "../../src/loop/git/drift";
import { recommendWorktreeIsolation } from "../../src/loop/git/isolation-advisor";

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

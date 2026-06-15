import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { captureGitBaseline } from "../../src/session/git-baseline";

let tmpDir: string;

function git(...args: string[]): void {
	const result = spawnSync("git", args, { cwd: tmpDir, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	}
}

function touch(name: string, content = "hello"): void {
	writeFileSync(join(tmpDir, name), content);
}

beforeEach(() => {
	tmpDir = join(tmpdir(), `spell-git-baseline-test-${Date.now()}`);
	mkdirSync(tmpDir, { recursive: true });
	git("init");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "Test");
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("captureGitBaseline", () => {
	it("returns null outside a git repo", async () => {
		const nonRepo = join(tmpdir(), `not-a-repo-${Date.now()}`);
		mkdirSync(nonRepo, { recursive: true });
		try {
			const result = await captureGitBaseline(nonRepo);
			expect(result).toBeNull();
		} finally {
			rmSync(nonRepo, { recursive: true, force: true });
		}
	});

	it("returns null when HEAD is unresolved (empty repo, no commits)", async () => {
		const result = await captureGitBaseline(tmpDir);
		expect(result).toBeNull();
	});

	it("returns a valid baseline after an initial commit", async () => {
		touch("README", "init");
		git("add", ".");
		git("commit", "-m", "init");

		const baseline = await captureGitBaseline(tmpDir);

		expect(baseline).not.toBeNull();
		expect(baseline!.head).toMatch(/^[0-9a-f]{40}$/);
		expect(baseline!.capturedAt).toBeTruthy();
		expect(baseline!.repoRoot).toBeTruthy();
	});
});

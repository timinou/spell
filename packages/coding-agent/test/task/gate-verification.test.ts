import { describe, expect, it } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	detectGitCommitInLog,
	detectHeadAdvanced,
	type ExecutionRecord,
	matchesGateCmd,
	normalizeCommand,
	verifyGateArtifact,
	verifyGates,
} from "../../src/task/gate-verification";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-verification-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

async function withGitRepo<T>(fn: (dir: string, baseline: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-verification-git-"));
	try {
		await $`git init -q`.cwd(dir).quiet().nothrow();
		await $`git config user.email test@example.com`.cwd(dir).quiet().nothrow();
		await $`git config user.name Test`.cwd(dir).quiet().nothrow();
		await fs.writeFile(path.join(dir, "a.txt"), "x");
		await $`git add . && git commit -q -m baseline`.cwd(dir).quiet().nothrow();
		const baseline = (await $`git rev-parse HEAD`.cwd(dir).quiet().nothrow().text()).trim();
		return await fn(dir, baseline);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

async function advanceHead(dir: string, name: string): Promise<void> {
	await fs.writeFile(path.join(dir, name), "y");
	await $`git add . && git commit -q -m ${name}`.cwd(dir).quiet().nothrow();
}

describe("gate verification", () => {
	describe("normalizeCommand", () => {
		it("passes through plain commands", () => {
			expect(normalizeCommand("bun test test/foo.test.ts")).toBe("bun test test/foo.test.ts");
		});

		it("trims whitespace", () => {
			expect(normalizeCommand("  bun test  ")).toBe("bun test");
		});

		it("strips cd prefixes with &&", () => {
			expect(normalizeCommand("cd /app && bun test foo.ts")).toBe("bun test foo.ts");
		});

		it("strips cd prefixes with ;", () => {
			expect(normalizeCommand("cd /app ; bun test")).toBe("bun test");
		});

		it("strips pushd prefixes", () => {
			expect(normalizeCommand("pushd /app && bun test")).toBe("bun test");
		});

		it("strips multiple cd prefixes", () => {
			expect(normalizeCommand("cd /app && cd sub && bun test")).toBe("bun test");
		});

		it("unwraps leading env assignments", () => {
			expect(normalizeCommand("env CI=1 bun test")).toBe("bun test");
			expect(normalizeCommand("CI=1 FOO=bar bun test")).toBe("bun test");
		});

		it("unwraps shell -c wrappers", () => {
			expect(normalizeCommand('sh -c "bun test"')).toBe("bun test");
			expect(normalizeCommand("bash -lc 'bun test foo.ts'")).toBe("bun test foo.ts");
		});

		it("preserves bare cd commands", () => {
			expect(normalizeCommand("cd /app")).toBe("cd /app");
		});

		it("handles empty strings", () => {
			expect(normalizeCommand("")).toBe("");
		});
	});

	describe("matchesGateCmd", () => {
		it("matches exact successful execution in the expected cwd", () => {
			const executions: ExecutionRecord[] = [{ command: "bun test", exitCode: 0, cwd: "/app" }];
			expect(matchesGateCmd("bun test", executions, "/app")).toBe(true);
		});

		it("matches exact command after normalization and cwd resolution", () => {
			const executions: ExecutionRecord[] = [
				{ command: "cd /app && bun test foo.ts", exitCode: 0, cwd: "/app" },
			];
			expect(matchesGateCmd("bun test foo.ts", executions, "/app")).toBe(true);
		});

		it("matches a gate that itself embeds a cd prefix against a bare execution in that dir", () => {
			// The djinn RC: gate string carries `cd packages/djinn && mix test …`;
			// the recorded execution ran the bare `mix test …` with cwd=packages/djinn.
			const executions: ExecutionRecord[] = [
				{ command: "mix test test/x_test.exs", exitCode: 0, cwd: "/repo/packages/djinn" },
			];
			expect(
				matchesGateCmd("cd packages/djinn && mix test test/x_test.exs", executions, "/repo"),
			).toBe(true);
		});

		it("matches transparent env wrappers", () => {
			const executions: ExecutionRecord[] = [{ command: "env CI=1 bun test", exitCode: 0, cwd: "/app" }];
			expect(matchesGateCmd("bun test", executions, "/app")).toBe(true);
		});

		it("matches transparent shell wrappers", () => {
			const executions: ExecutionRecord[] = [{ command: 'sh -c "bun test"', exitCode: 0, cwd: "/app" }];
			expect(matchesGateCmd("bun test", executions, "/app")).toBe(true);
		});

		it("matches prefix with extra arguments", () => {
			const executions: ExecutionRecord[] = [{ command: "bun test foo.ts", exitCode: 0, cwd: "/app" }];
			expect(matchesGateCmd("bun test", executions, "/app")).toBe(true);
		});

		it("matches when gateCmd is followed by a shell pipe", () => {
			const executions: ExecutionRecord[] = [{ command: "bun test | tail -5", exitCode: 0, cwd: "/app" }];
			expect(matchesGateCmd("bun test", executions, "/app")).toBe(true);
		});

		it("matches when gateCmd is followed by a redirect", () => {
			const executions: ExecutionRecord[] = [{ command: "bun test 2>&1", exitCode: 0, cwd: "/app" }];
			expect(matchesGateCmd("bun test", executions, "/app")).toBe(true);
		});

		it("matches gateCmd with pipe and redirect combined", () => {
			const executions: ExecutionRecord[] = [
				{ command: "cd /app && cargo test -p pi-code-engine watcher 2>&1 | tail -5", exitCode: 0, cwd: "/app" },
			];
			expect(matchesGateCmd("cargo test -p pi-code-engine watcher", executions, "/app")).toBe(true);
		});

		it("matches gateCmd with extra flags", () => {
			const executions: ExecutionRecord[] = [
				{ command: "cargo test --workspace --verbose", exitCode: 0, cwd: "/app" },
			];
			expect(matchesGateCmd("cargo test --workspace", executions, "/app")).toBe(true);
		});

		it("matches shell wrapper with pipe and redirect", () => {
			const executions: ExecutionRecord[] = [
				{ command: 'sh -c "cargo test -p foo 2>&1 | tail -5"', exitCode: 0, cwd: "/app" },
			];
			expect(matchesGateCmd("cargo test -p foo", executions, "/app")).toBe(true);
		});

		it("matches when followed by && chain", () => {
			const executions: ExecutionRecord[] = [
				{ command: "cargo test -p foo && echo done", exitCode: 0, cwd: "/app" },
			];
			expect(matchesGateCmd("cargo test -p foo", executions, "/app")).toBe(true);
		});

		it("matches background operator", () => {
			const executions: ExecutionRecord[] = [{ command: "cargo test &", exitCode: 0, cwd: "/app" }];
			expect(matchesGateCmd("cargo test", executions, "/app")).toBe(true);
		});

		it("matches env assignments with pipe", () => {
			const executions: ExecutionRecord[] = [
				{ command: "CI=1 RUST_BACKTRACE=1 cargo test | tail -5", exitCode: 0, cwd: "/app" },
			];
			expect(matchesGateCmd("cargo test", executions, "/app")).toBe(true);
		});

		it("matches when execution appends output redirect to file", () => {
			const executions: ExecutionRecord[] = [
				{ command: "bun test > test-output.log", exitCode: 0, cwd: "/app" },
			];
			expect(matchesGateCmd("bun test", executions, "/app")).toBe(true);
		});

		it("matches heredoc appended after command", () => {
			const executions: ExecutionRecord[] = [
				{ command: "cat <<'EOF'\nsome content\nEOF", exitCode: 0, cwd: "/app" },
			];
			expect(matchesGateCmd("cat", executions, "/app")).toBe(true);
		});

		// -- negative: boundary enforcement --

		it("returns false when gateCmd is a substring inside a word (boundary guard)", () => {
			const executions: ExecutionRecord[] = [{ command: "cargo test -p foobar", exitCode: 0, cwd: "/app" }];
			expect(matchesGateCmd("cargo test -p foo", executions, "/app")).toBe(false);
		});

		it("returns false when gateCmd is more specific than execution", () => {
			const executions: ExecutionRecord[] = [{ command: "bun test", exitCode: 0, cwd: "/app" }];
			expect(matchesGateCmd("bun test --verbose", executions, "/app")).toBe(false);
		});

		it("returns false when execution is a prefix of the gate (run too little)", () => {
			const executions: ExecutionRecord[] = [{ command: "cargo test", exitCode: 0, cwd: "/app" }];
			expect(matchesGateCmd("cargo test --workspace", executions, "/app")).toBe(false);
		});

		it("returns false for semicolon without space boundary", () => {
			const executions: ExecutionRecord[] = [{ command: "bun test;echo done", exitCode: 0, cwd: "/app" }];
			expect(matchesGateCmd("bun test", executions, "/app")).toBe(false);
		});

		it("returns false when gateCmd is empty", () => {
			const executions: ExecutionRecord[] = [{ command: "bun test", exitCode: 0, cwd: "/app" }];
			expect(matchesGateCmd("", executions, "/app")).toBe(false);
		});

		it("returns false when gateCmd is whitespace only", () => {
			const executions: ExecutionRecord[] = [{ command: "bun test", exitCode: 0, cwd: "/app" }];
			expect(matchesGateCmd("   ", executions, "/app")).toBe(false);
		});

		it("returns false when gateCmd equals execution plus extra content", () => {
			const executions: ExecutionRecord[] = [{ command: "bun test", exitCode: 0, cwd: "/app" }];
			expect(matchesGateCmd("bun test file.ts", executions, "/app")).toBe(false);
		});

		it("returns false when the cwd does not match", () => {
			const executions: ExecutionRecord[] = [{ command: "bun test", exitCode: 0, cwd: "/other" }];
			expect(matchesGateCmd("bun test", executions, "/app")).toBe(false);
		});

		it("returns false when no command matches", () => {
			const executions: ExecutionRecord[] = [{ command: "bun lint", exitCode: 0, cwd: "/app" }];
			expect(matchesGateCmd("bun test", executions, "/app")).toBe(false);
		});

		it("returns false for empty executions", () => {
			expect(matchesGateCmd("bun test", [], "/app")).toBe(false);
		});

		it("ignores failed executions", () => {
			const executions: ExecutionRecord[] = [{ command: "bun test", exitCode: 1, cwd: "/app" }];
			expect(matchesGateCmd("bun test", executions, "/app")).toBe(false);
		});

		it("is case sensitive", () => {
			const executions: ExecutionRecord[] = [{ command: "BUN TEST", exitCode: 0, cwd: "/app" }];
			expect(matchesGateCmd("bun test", executions, "/app")).toBe(false);
		});
	});

	describe("detectHeadAdvanced", () => {
		it("returns true when HEAD moved past the baseline", async () => {
			await withGitRepo(async (dir, baseline) => {
				await advanceHead(dir, "b.txt");
				expect(await detectHeadAdvanced(dir, baseline)).toBe(true);
			});
		});

		it("returns false when HEAD is unchanged", async () => {
			await withGitRepo(async (dir, baseline) => {
				expect(await detectHeadAdvanced(dir, baseline)).toBe(false);
			});
		});

		it("returns false in a non-git directory", async () => {
			await withTempDir(async dir => {
				expect(await detectHeadAdvanced(dir, "0".repeat(40))).toBe(false);
			});
		});
	});

	describe("detectGitCommitInLog", () => {
		it("detects a successful git commit in the log", () => {
			expect(detectGitCommitInLog([{ command: "git commit -m fix", exitCode: 0 }])).toBe(true);
		});
		it("detects a commit behind a cd / shell wrapper", () => {
			expect(detectGitCommitInLog([{ command: "cd repo && git commit -m x", exitCode: 0 }])).toBe(true);
			expect(detectGitCommitInLog([{ command: "sh -c 'git commit -m x'", exitCode: 0 }])).toBe(true);
		});
		it("ignores failed commits and non-commit git commands", () => {
			expect(detectGitCommitInLog([{ command: "git commit -m x", exitCode: 1 }])).toBe(false);
			expect(detectGitCommitInLog([{ command: "git add .", exitCode: 0 }])).toBe(false);
			expect(detectGitCommitInLog([{ command: "git-commit", exitCode: 0 }])).toBe(false);
		});
		it("returns false for an empty log", () => {
			expect(detectGitCommitInLog([])).toBe(false);
		});
	});

	describe("verifyGateArtifact", () => {
		it("returns true when the file exists", async () => {
			await withTempDir(async dir => {
				const artifact = path.join(dir, "artifact.txt");
				await fs.writeFile(artifact, "ok");
				expect(await verifyGateArtifact(artifact, dir)).toBe(true);
			});
		});

		it("returns false when the file does not exist", async () => {
			await withTempDir(async dir => {
				expect(await verifyGateArtifact(path.join(dir, "missing.txt"), dir)).toBe(false);
			});
		});

		it("resolves relative paths against cwd", async () => {
			await withTempDir(async dir => {
				await fs.writeFile(path.join(dir, "artifact.txt"), "ok");
				expect(await verifyGateArtifact("artifact.txt", dir)).toBe(true);
			});
		});
	});

	describe("verifyGates", () => {
		it("passes when no gates are configured", async () => {
			const result = await verifyGates({ executions: [], cwd: os.tmpdir() });
			expect(result).toEqual({ passed: true, failures: [] });
		});

		it("passes when gateCmd is satisfied", async () => {
			const result = await verifyGates({
				gateCmd: "bun test",
				executions: [{ command: 'sh -c "bun test"', exitCode: 0, cwd: "/app" }],
				cwd: "/app",
			});
			expect(result.passed).toBe(true);
			expect(result.failures).toEqual([]);
		});

		it("fails when gateCmd is run from the wrong cwd", async () => {
			const result = await verifyGates({
				gateCmd: "bun test",
				executions: [{ command: "bun test", exitCode: 0, cwd: "/other" }],
				cwd: "/app",
			});
			expect(result.passed).toBe(false);
			expect(result.failures).toEqual([
				{ gate: "gateCmd", expected: "bun test", detail: "No successful execution matched the gate command." },
			]);
		});

		it("fails when gateCmd is not satisfied", async () => {
			const result = await verifyGates({
				gateCmd: "bun test",
				executions: [{ command: "bun lint", exitCode: 0, cwd: "/app" }],
				cwd: "/app",
			});
			expect(result.passed).toBe(false);
			expect(result.failures).toEqual([
				{ gate: "gateCmd", expected: "bun test", detail: "No successful execution matched the gate command." },
			]);
		});

		it("passes when gateCommit HEAD advanced past the baseline (no executions needed)", async () => {
			await withGitRepo(async (dir, baseline) => {
				await advanceHead(dir, "b.txt");
				const result = await verifyGates({
					gateCommit: true,
					executions: [],
					cwd: dir,
					baselineHeadCommit: baseline,
				});
				expect(result.passed).toBe(true);
			});
		});

		it("fails gateCommit when HEAD did not advance, regardless of command log", async () => {
			await withGitRepo(async (dir, baseline) => {
				const result = await verifyGates({
					gateCommit: true,
					executions: [{ command: "git commit -m noop", exitCode: 0, cwd: dir }],
					cwd: dir,
					baselineHeadCommit: baseline,
				});
				expect(result.passed).toBe(false);
				expect(result.failures[0]?.gate).toBe("gateCommit");
				expect(result.failures[0]?.detail).toBe("HEAD did not advance past the pre-work baseline.");
			});
		});

		it("fails gateCommit when no baseline is available", async () => {
			const result = await verifyGates({ gateCommit: true, executions: [], cwd: os.tmpdir() });
			expect(result.passed).toBe(false);
			expect(result.failures[0]?.gate).toBe("gateCommit");
			expect(result.failures[0]?.detail).toBe("No git baseline was available to verify the commit against.");
		});

		it("with requireCommitInLog: passes when HEAD advanced AND this task's log shows a commit", async () => {
			await withGitRepo(async (dir, baseline) => {
				await advanceHead(dir, "b.txt");
				const result = await verifyGates({
					gateCommit: true,
					executions: [{ command: "git commit -m work", exitCode: 0, cwd: dir }],
					cwd: dir,
					baselineHeadCommit: baseline,
					requireCommitInLog: true,
				});
				expect(result.passed).toBe(true);
			});
		});

		it("with requireCommitInLog: FAILS when HEAD advanced but this task's log shows no commit (sibling moved HEAD)", async () => {
			await withGitRepo(async (dir, baseline) => {
				// HEAD advanced (e.g. a concurrent sibling committed in the shared tree),
				// but THIS task never committed — attribution guard must fail it.
				await advanceHead(dir, "b.txt");
				const result = await verifyGates({
					gateCommit: true,
					executions: [{ command: "bun test", exitCode: 0, cwd: dir }],
					cwd: dir,
					baselineHeadCommit: baseline,
					requireCommitInLog: true,
				});
				expect(result.passed).toBe(false);
				expect(result.failures[0]?.gate).toBe("gateCommit");
				expect(result.failures[0]?.detail).toContain("No git commit by this task");
			});
		});

		it("without requireCommitInLog (isolated/direct): HEAD advance alone passes", async () => {
			await withGitRepo(async (dir, baseline) => {
				await advanceHead(dir, "b.txt");
				const result = await verifyGates({
					gateCommit: true,
					executions: [{ command: "bun test", exitCode: 0, cwd: dir }],
					cwd: dir,
					baselineHeadCommit: baseline,
				});
				expect(result.passed).toBe(true);
			});
		});

		it("resolves the commit gate against the worktree dir when set", async () => {
			await withGitRepo(async (dir, baseline) => {
				await advanceHead(dir, "b.txt");
				const result = await verifyGates({
					gateCommit: true,
					executions: [],
					cwd: os.tmpdir(),
					worktreeDir: dir,
					baselineHeadCommit: baseline,
				});
				expect(result.passed).toBe(true);
			});
		});

		it("passes when gateArtifact exists", async () => {
			await withTempDir(async dir => {
				const artifact = path.join(dir, "artifact.txt");
				await fs.writeFile(artifact, "ok");
				const result = await verifyGates({ gateArtifact: artifact, executions: [], cwd: dir });
				expect(result.passed).toBe(true);
			});
		});

		it("fails when gateArtifact is missing", async () => {
			const result = await verifyGates({ gateArtifact: "missing.txt", executions: [], cwd: os.tmpdir() });
			expect(result.passed).toBe(false);
			expect(result.failures[0]?.gate).toBe("gateArtifact");
		});

		it("passes when multiple gates all pass", async () => {
			await withGitRepo(async (dir, baseline) => {
				const artifact = path.join(dir, "artifact.txt");
				await fs.writeFile(artifact, "ok");
				await advanceHead(dir, "b.txt");
				const result = await verifyGates({
					gateCmd: "bun test",
					gateCommit: true,
					gateArtifact: artifact,
					executions: [{ command: "env CI=1 bun test", exitCode: 0, cwd: dir }],
					cwd: dir,
					baselineHeadCommit: baseline,
				});
				expect(result).toEqual({ passed: true, failures: [] });
			});
		});

		it("fails with the failing gate when multiple gates are configured", async () => {
			await withGitRepo(async (dir, baseline) => {
				const artifact = path.join(dir, "artifact.txt");
				await fs.writeFile(artifact, "ok");
				await advanceHead(dir, "b.txt");
				const result = await verifyGates({
					gateCmd: "bun test",
					gateCommit: true,
					gateArtifact: artifact,
					executions: [{ command: "pnpm test", exitCode: 0, cwd: dir }],
					cwd: dir,
					baselineHeadCommit: baseline,
				});
				expect(result.passed).toBe(false);
				expect(result.failures.length).toBe(1);
				expect(result.failures[0]).toEqual({
					gate: "gateCmd",
					expected: "bun test",
					detail: "No successful execution matched the gate command.",
				});
			});
		});
	});
});

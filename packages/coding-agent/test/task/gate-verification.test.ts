import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	detectGitCommit,
	matchesGateCmd,
	normalizeCommand,
	type TrackedBashExecution,
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

describe("gate verification", () => {
	afterEach(() => {
		// no shared state
	});

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
			const executions: TrackedBashExecution[] = [{ command: "bun test", exitCode: 0, cwd: "/app" }];
			expect(matchesGateCmd("bun test", executions, "/app")).toBe(true);
		});

		it("matches exact command after normalization and cwd resolution", () => {
			const executions: TrackedBashExecution[] = [
				{ command: "cd /app && bun test foo.ts", exitCode: 0, cwd: "/app" },
			];
			expect(matchesGateCmd("bun test foo.ts", executions, "/app")).toBe(true);
		});

		it("matches transparent env wrappers", () => {
			const executions: TrackedBashExecution[] = [{ command: "env CI=1 bun test", exitCode: 0, cwd: "/app" }];
			expect(matchesGateCmd("bun test", executions, "/app")).toBe(true);
		});

		it("matches transparent shell wrappers", () => {
			const executions: TrackedBashExecution[] = [{ command: 'sh -c "bun test"', exitCode: 0, cwd: "/app" }];
			expect(matchesGateCmd("bun test", executions, "/app")).toBe(true);
		});

		it("returns false when only a substring matches", () => {
			const executions: TrackedBashExecution[] = [{ command: "bun test foo.ts", exitCode: 0, cwd: "/app" }];
			expect(matchesGateCmd("bun test", executions, "/app")).toBe(false);
		});

		it("returns false when the cwd does not match", () => {
			const executions: TrackedBashExecution[] = [{ command: "bun test", exitCode: 0, cwd: "/other" }];
			expect(matchesGateCmd("bun test", executions, "/app")).toBe(false);
		});

		it("returns false when no command matches", () => {
			const executions: TrackedBashExecution[] = [{ command: "bun lint", exitCode: 0, cwd: "/app" }];
			expect(matchesGateCmd("bun test", executions, "/app")).toBe(false);
		});

		it("returns false for empty executions", () => {
			expect(matchesGateCmd("bun test", [], "/app")).toBe(false);
		});

		it("ignores failed executions", () => {
			const executions: TrackedBashExecution[] = [{ command: "bun test", exitCode: 1, cwd: "/app" }];
			expect(matchesGateCmd("bun test", executions, "/app")).toBe(false);
		});

		it("is case sensitive", () => {
			const executions: TrackedBashExecution[] = [{ command: "BUN TEST", exitCode: 0, cwd: "/app" }];
			expect(matchesGateCmd("bun test", executions, "/app")).toBe(false);
		});
	});

	describe("detectGitCommit", () => {
		it("detects git commit", () => {
			const executions: TrackedBashExecution[] = [{ command: "git commit -m 'fix'", exitCode: 0 }];
			expect(detectGitCommit(executions)).toBe(true);
		});

		it("detects amend commits", () => {
			const executions: TrackedBashExecution[] = [{ command: "git commit --amend", exitCode: 0 }];
			expect(detectGitCommit(executions)).toBe(true);
		});

		it("ignores git add", () => {
			const executions: TrackedBashExecution[] = [{ command: "git add .", exitCode: 0 }];
			expect(detectGitCommit(executions)).toBe(false);
		});

		it("returns false for empty arrays", () => {
			expect(detectGitCommit([])).toBe(false);
		});

		it("detects commits behind cd prefixes", () => {
			const executions: TrackedBashExecution[] = [{ command: "cd repo && git commit -m fix", exitCode: 0 }];
			expect(detectGitCommit(executions)).toBe(true);
		});

		it("does not match git-commit", () => {
			const executions: TrackedBashExecution[] = [{ command: "git-commit", exitCode: 0 }];
			expect(detectGitCommit(executions)).toBe(false);
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

		it("passes when gateCommit is detected", async () => {
			const result = await verifyGates({
				gateCommit: true,
				executions: [{ command: "git commit -m fix", exitCode: 0 }],
				cwd: os.tmpdir(),
			});
			expect(result.passed).toBe(true);
		});

		it("fails when gateCommit is not detected", async () => {
			const result = await verifyGates({
				gateCommit: true,
				executions: [{ command: "git add .", exitCode: 0 }],
				cwd: os.tmpdir(),
			});
			expect(result.passed).toBe(false);
			expect(result.failures[0]?.gate).toBe("gateCommit");
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
			await withTempDir(async dir => {
				const artifact = path.join(dir, "artifact.txt");
				await fs.writeFile(artifact, "ok");
				const result = await verifyGates({
					gateCmd: "bun test",
					gateCommit: true,
					gateArtifact: artifact,
					executions: [
						{ command: "env CI=1 bun test", exitCode: 0, cwd: dir },
						{ command: "git commit -m fix", exitCode: 0 },
					],
					cwd: dir,
				});
				expect(result).toEqual({ passed: true, failures: [] });
			});
		});

		it("fails with the failing gate when multiple gates are configured", async () => {
			await withTempDir(async dir => {
				const artifact = path.join(dir, "artifact.txt");
				await fs.writeFile(artifact, "ok");
				const result = await verifyGates({
					gateCmd: "bun test",
					gateCommit: true,
					gateArtifact: artifact,
					executions: [
						{ command: "pnpm test", exitCode: 0, cwd: dir },
						{ command: "git commit -m fix", exitCode: 0 },
					],
					cwd: dir,
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

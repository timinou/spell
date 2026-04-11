import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const BUN_PATH = Bun.which("bun") ?? process.argv[0] ?? "bun";
const BUN_DIR = path.dirname(BUN_PATH);
const CLI_PATH = path.resolve(import.meta.dir, "../src/cli.ts");
const decoder = new TextDecoder();
const DEAD_PID = 999_999;

interface CliRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface RunCliOptions {
	homeDir: string;
	cwd: string;
	pathValue?: string;
	env?: Record<string, string>;
}

interface StatusFileFixture {
	status: "idle" | "running" | "needs_input" | "error" | "completed" | "pending_approval" | "user_paused";
	windowId: number;
	pid: number;
	projectName: string;
	sessionTitle: string;
	updatedAt: number;
	sessionId?: string;
	sessionFile?: string;
	cwd?: string;
	workspaceName?: string | null;
}

interface StubBinOptions {
	ghostty?: {
		failSessionId?: string;
	};
	niri?: boolean;
}

function runCli(args: string[], options: RunCliOptions): CliRunResult {
	const pathValue =
		options.pathValue !== undefined
			? [options.pathValue, BUN_DIR].filter(segment => segment.length > 0).join(":")
			: (process.env.PATH ?? "");
	const command = `exec ${shellQuote(BUN_PATH)} ${[CLI_PATH, ...args].map(shellQuote).join(" ")}`;
	const result = Bun.spawnSync(["/bin/sh", "-c", command], {
		cwd: options.cwd,
		env: {
			HOME: options.homeDir,
			NO_COLOR: "1",
			PATH: pathValue,
			PI_CODING_AGENT_DIR: path.join(options.homeDir, ".spell", "agent"),
			TERM: "dumb",
			...options.env,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: result.exitCode,
		stdout: decoder.decode(result.stdout),
		stderr: decoder.decode(result.stderr),
	};
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function createExecutable(filePath: string, content: string): Promise<void> {
	await Bun.write(filePath, content);
	await fs.chmod(filePath, 0o755);
}

async function createStubBin(
	tempDir: string,
	options: StubBinOptions,
): Promise<{
	binDir: string;
	ghosttyLogPath: string;
	niriLogPath: string;
}> {
	const binDir = path.join(tempDir, "bin");
	const ghosttyLogPath = path.join(tempDir, "ghostty.log");
	const niriLogPath = path.join(tempDir, "niri.log");
	await fs.mkdir(binDir, { recursive: true });
	await Bun.write(ghosttyLogPath, "");
	await Bun.write(niriLogPath, "");

	if (options.ghostty) {
		const ghosttyScript = `#!/bin/sh
printf '%s\n' "$*" >> ${shellQuote(ghosttyLogPath)}
case "$*" in
  *" -r ${options.ghostty.failSessionId ?? "__never__"}"*)
    exit 1
    ;;
esac
exit 0
`;
		await createExecutable(path.join(binDir, "ghostty"), ghosttyScript);
	}

	if (options.niri) {
		const niriScript = `#!/bin/sh
printf '%s\n' "$*" >> ${shellQuote(niriLogPath)}
exit 0
`;
		await createExecutable(path.join(binDir, "niri"), niriScript);
	}

	return { binDir, ghosttyLogPath, niriLogPath };
}

async function writeStatusFile(
	homeDir: string,
	windowId: number,
	overrides: Partial<StatusFileFixture> = {},
): Promise<string> {
	const statusDir = path.join(homeDir, ".spell", "status");
	const defaultCwd = path.join(homeDir, `workspace-${windowId}`);
	const payload: StatusFileFixture = {
		status: "running",
		windowId,
		pid: DEAD_PID,
		projectName: `project-${windowId}`,
		sessionTitle: `session-${windowId}`,
		updatedAt: Date.now(),
		sessionId: `sess-${windowId}`,
		sessionFile: path.join(homeDir, `session-${windowId}.jsonl`),
		cwd: defaultCwd,
		workspaceName: null,
		...overrides,
	};
	const filePath = path.join(statusDir, `${windowId}.json`);
	await Bun.write(filePath, `${JSON.stringify(payload)}\n`);
	return filePath;
}

describe("spell recover command", () => {
	let tempDir = "";
	let homeDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-recover-command-"));
		homeDir = path.join(tempDir, "home");
		await fs.mkdir(homeDir, { recursive: true });
	});

	afterEach(async () => {
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("prints a friendly message when no crashed sessions exist", () => {
		const result = runCli(["recover"], { cwd: tempDir, homeDir });

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("No crashed sessions to recover.");
	});

	it("shows dry-run ghostty and niri commands when both tools are available", async () => {
		await writeStatusFile(homeDir, 1, {
			projectName: "alpha",
			sessionTitle: "first",
			cwd: "/tmp/alpha",
			workspaceName: "ws-alpha",
		});
		await writeStatusFile(homeDir, 2, {
			projectName: "beta",
			sessionTitle: "second",
			cwd: "/tmp/beta",
			workspaceName: "ws-beta",
		});
		const stubs = await createStubBin(tempDir, { ghostty: {}, niri: true });

		const result = runCli(["recover", "--dry-run"], {
			cwd: tempDir,
			homeDir,
			pathValue: stubs.binDir,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Dry run — showing planned recovery commands:");
		expect(result.stdout).toContain("niri msg action focus-workspace ws-alpha");
		expect(result.stdout).toContain("niri msg action focus-workspace ws-beta");
		expect(result.stdout).toContain("ghostty +new-window --working-directory=/tmp/alpha -e spell -r sess-1");
		expect(result.stdout).toContain("ghostty +new-window --working-directory=/tmp/beta -e spell -r sess-2");
		expect(await Bun.file(path.join(homeDir, ".spell", "status", "1.json")).exists()).toBe(true);
		expect(await Bun.file(path.join(homeDir, ".spell", "status", "2.json")).exists()).toBe(true);
	});

	it("falls back to manual resume commands when ghostty is unavailable", async () => {
		await writeStatusFile(homeDir, 3, {
			projectName: "gamma",
			sessionTitle: "third",
			cwd: "/tmp/gamma",
			workspaceName: "ws-gamma",
		});

		const result = runCli(["recover", "--dry-run"], {
			cwd: tempDir,
			homeDir,
			pathValue: "",
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Dry run — showing manual fallback commands (ghostty not found):");
		expect(result.stdout).toContain("(niri not found: workspace commands omitted)");
		expect(result.stdout).toContain("cd /tmp/gamma && spell -r sess-3");
	});

	it("skips stale files with incomplete recovery metadata", async () => {
		await writeStatusFile(homeDir, 4, {
			projectName: "legacy",
			sessionTitle: "old",
			sessionId: undefined,
			cwd: undefined,
		});

		const result = runCli(["recover"], { cwd: tempDir, homeDir });

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("No recoverable crashed sessions found.");
		expect(result.stderr).toContain("recovery metadata is incomplete");
	});

	it("recovers sessions with ghostty and keeps going when niri is unavailable", async () => {
		const statusPath = await writeStatusFile(homeDir, 5, {
			projectName: "delta",
			sessionTitle: "fourth",
			cwd: "/tmp/delta",
			workspaceName: "ws-delta",
		});
		const stubs = await createStubBin(tempDir, { ghostty: {} });

		const result = runCli(["recover"], {
			cwd: tempDir,
			homeDir,
			pathValue: stubs.binDir,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Recovered delta: fourth.");
		expect(result.stdout).toContain("Recovered 1 session(s).");
		expect(result.stderr).toContain("niri not found; recovering sessions without workspace restoration.");
		expect(await Bun.file(statusPath).exists()).toBe(false);
		expect(await Bun.file(stubs.ghosttyLogPath).text()).toContain(
			"+new-window --working-directory=/tmp/delta -e spell -r sess-5",
		);
	});

	it("leaves failed recovery status files in place while cleaning up successful ones", async () => {
		const successfulPath = await writeStatusFile(homeDir, 6, {
			projectName: "epsilon",
			sessionTitle: "success",
			cwd: "/tmp/epsilon",
			sessionId: "sess-success",
		});
		const failedPath = await writeStatusFile(homeDir, 7, {
			projectName: "zeta",
			sessionTitle: "failure",
			cwd: "/tmp/zeta",
			sessionId: "sess-fail",
		});
		const stubs = await createStubBin(tempDir, { ghostty: { failSessionId: "sess-fail" } });

		const result = runCli(["recover"], {
			cwd: tempDir,
			homeDir,
			pathValue: stubs.binDir,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Recovered epsilon: success.");
		expect(result.stderr).toContain("Warning: failed to recover zeta: failure.");
		expect(result.stderr).toContain("Recovery failed for 1 session(s); their status files were left in place.");
		expect(await Bun.file(successfulPath).exists()).toBe(false);
		expect(await Bun.file(failedPath).exists()).toBe(true);
	});

	it("explains when --no-workspace suppresses workspace restoration in dry-run output", async () => {
		await writeStatusFile(homeDir, 8, {
			projectName: "eta",
			sessionTitle: "workspace-skip",
			cwd: "/tmp/eta",
			workspaceName: "ws-eta",
		});
		const stubs = await createStubBin(tempDir, { ghostty: {}, niri: true });

		const result = runCli(["recover", "--dry-run", "--no-workspace"], {
			cwd: tempDir,
			homeDir,
			pathValue: stubs.binDir,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("(--no-workspace: workspace commands omitted)");
		expect(result.stdout).not.toContain("niri msg action focus-workspace");
	});

	it("shows a startup warning when recoverable crashed sessions exist", async () => {
		await writeStatusFile(homeDir, 9, { projectName: "theta", sessionTitle: "notify" });

		const result = runCli(["--print", "hello"], { cwd: tempDir, homeDir });

		expect(result.stderr).toContain("crashed session(s) detected. Run 'spell recover' to restore.");
	});

	it("suppresses the startup warning for --resume", async () => {
		await writeStatusFile(homeDir, 10, { projectName: "iota", sessionTitle: "resume-suppressed" });

		const result = runCli(["--resume", "missing-session"], { cwd: tempDir, homeDir });

		expect(result.stderr).not.toContain("crashed session(s) detected. Run 'spell recover' to restore.");
	});

	it("suppresses the startup warning for --continue", async () => {
		await writeStatusFile(homeDir, 11, { projectName: "kappa", sessionTitle: "continue-suppressed" });

		const result = runCli(["--continue", "--print", "hello"], { cwd: tempDir, homeDir });

		expect(result.stderr).not.toContain("crashed session(s) detected. Run 'spell recover' to restore.");
	});

	it("suppresses the startup warning for --no-session", async () => {
		await writeStatusFile(homeDir, 12, { projectName: "lambda", sessionTitle: "no-session-suppressed" });

		const result = runCli(["--no-session", "--print", "hello"], { cwd: tempDir, homeDir });

		expect(result.stderr).not.toContain("crashed session(s) detected. Run 'spell recover' to restore.");
	});

	it("does not show a startup warning when only legacy stale files exist", async () => {
		await writeStatusFile(homeDir, 11, {
			projectName: "legacy-only",
			sessionTitle: "stale",
			sessionId: undefined,
			cwd: undefined,
		});

		const result = runCli(["--print", "hello"], { cwd: tempDir, homeDir });

		expect(result.stderr).not.toContain("crashed session(s) detected. Run 'spell recover' to restore.");
	});
});

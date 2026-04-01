import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildDomainLaunchArgv } from "../src/commands/domain-entry";

const CLI_PATH = path.resolve(import.meta.dir, "../src/cli.ts");
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const decoder = new TextDecoder();

interface CliRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function runCli(args: string[], cwd: string, homeDir: string): CliRunResult {
	const result = Bun.spawnSync([process.execPath, CLI_PATH, ...args], {
		cwd,
		env: {
			HOME: homeDir,
			NO_COLOR: "1",
			PATH: process.env.PATH ?? "",
			PI_CODING_AGENT_DIR: path.join(homeDir, ".spell", "agent"),
			TERM: "dumb",
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

describe("CLI domain command routing", () => {
	let tempDir = "";
	let homeDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-domain-command-"));
		homeDir = path.join(tempDir, "home");
		await fs.mkdir(homeDir, { recursive: true });
		await Bun.write(
			path.join(tempDir, "domain", "growth", "manifest.ts"),
			'throw new Error("workspace manifest should not load"); export default {};',
		);
	});

	afterEach(async () => {
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps the command-selected domain authoritative over conflicting --domain flags", () => {
		expect(buildDomainLaunchArgv("growth", ["--domain", "coding", "-p", "hello"])).toEqual([
			"--domain",
			"growth",
			"-p",
			"hello",
		]);
	});

	it("routes spell domain growth through the same startup path as --domain growth", () => {
		const viaFlag = runCli(["--domain", "growth", "--no-session", "-p", "hello"], tempDir, homeDir);
		const viaCommand = runCli(["domain", "growth", "--no-session", "-p", "hello"], tempDir, homeDir);

		expect(viaCommand.exitCode).toBe(viaFlag.exitCode);
		expect(viaCommand.stdout).toBe(viaFlag.stdout);
		expect(viaCommand.stderr).toBe(viaFlag.stderr);
		expect(viaCommand.stderr).toContain("No models available.");
		expect(viaCommand.stderr).not.toContain("Failed to load domain manifest");
		expect(viaCommand.stderr).not.toContain("workspace manifest should not load");
	});

	it("routes spell growth through the same startup path as spell domain growth", () => {
		const viaDomainCommand = runCli(["domain", "growth", "--no-session", "-p", "hello"], tempDir, homeDir);
		const viaAlias = runCli(["growth", "--no-session", "-p", "hello"], tempDir, homeDir);

		expect(viaAlias.exitCode).toBe(viaDomainCommand.exitCode);
		expect(viaAlias.stdout).toBe(viaDomainCommand.stdout);
		expect(viaAlias.stderr).toBe(viaDomainCommand.stderr);
		expect(viaAlias.stderr).toContain("No models available.");
	});

	it("shows the canonical domain command in root help", () => {
		const help = runCli(["--help"], REPO_ROOT, homeDir);

		expect(help.exitCode).toBe(0);
		expect(help.stdout).toContain("domain");
		expect(help.stdout).toContain("Start a Spell domain");
		expect(help.stdout).toContain("spell domain growth");
		expect(help.stdout).not.toContain("growth  Start the growth domain");
	});
});

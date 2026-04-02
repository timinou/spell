import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { GoalResult, GoalRun } from "../../src/executor";
import type { HookContext } from "../../src/hooks";
import { OrgHookExecutor } from "../../src/hooks";
import type { OrgHook } from "../../src/manifest";

const previousPath = Bun.env.PATH;
const previousLogPath = Bun.env.SPELL_TEST_ORG_LOG;
const previousExitCode = Bun.env.SPELL_TEST_ORG_EXIT_CODE;
const previousCwd = process.cwd();
const tempDirs = new Set<string>();

const BASE_CONTEXT: HookContext = {
	goalName: "nightly",
	timestamp: new Date("2026-04-02T12:34:56.000Z"),
};

const FAILURE_RUN: GoalRun = {
	runId: "nightly-1",
	goalName: "nightly",
	startedAt: new Date("2026-04-02T12:30:00.000Z"),
	completedAt: new Date("2026-04-02T12:31:00.000Z"),
	status: "failed",
	error: "rpc blew up",
	attempt: 1,
};

const FAILURE_RESULT: GoalResult = {
	goalName: "nightly",
	status: "failure",
	duration: 60_000,
	error: "rpc blew up",
	runs: [FAILURE_RUN],
};

const SUCCESS_RESULT: GoalResult = {
	goalName: "nightly",
	status: "success",
	duration: 321,
	summary: "All checks passed",
	runs: [
		{
			runId: "nightly-2",
			goalName: "nightly",
			startedAt: new Date("2026-04-02T12:35:00.000Z"),
			completedAt: new Date("2026-04-02T12:35:30.000Z"),
			status: "completed",
			attempt: 1,
		},
	],
};

afterEach(async () => {
	process.chdir(previousCwd);
	if (previousPath === undefined) delete Bun.env.PATH;
	else Bun.env.PATH = previousPath;
	if (previousLogPath === undefined) delete Bun.env.SPELL_TEST_ORG_LOG;
	else Bun.env.SPELL_TEST_ORG_LOG = previousLogPath;
	if (previousExitCode === undefined) delete Bun.env.SPELL_TEST_ORG_EXIT_CODE;
	else Bun.env.SPELL_TEST_ORG_EXIT_CODE = previousExitCode;
	await Promise.all(
		[...tempDirs].map(async tempDir => {
			tempDirs.delete(tempDir);
			await fs.rm(tempDir, { recursive: true, force: true });
		}),
	);
});

async function createWorkspace(
	options: { withTasksDir?: boolean; installSpell?: boolean; spellExitCode?: number } = {},
): Promise<{ root: string; logPath: string; spellPath: string | null }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "spell-org-hook-"));
	tempDirs.add(root);
	const withTasksDir = options.withTasksDir ?? true;
	const installSpell = options.installSpell ?? true;
	const spellExitCode = options.spellExitCode ?? 0;
	if (withTasksDir) {
		await fs.mkdir(path.join(root, "!tasks"), { recursive: true });
	}
	const binDir = path.join(root, "bin");
	await fs.mkdir(binDir, { recursive: true });
	const logPath = path.join(root, "org-create-log.json");
	Bun.env.SPELL_TEST_ORG_LOG = logPath;
	Bun.env.SPELL_TEST_ORG_EXIT_CODE = String(spellExitCode);
	let spellPath: string | null = null;
	if (installSpell) {
		spellPath = path.join(binDir, "spell");
		await Bun.write(
			spellPath,
			`#!/usr/bin/env bun\nimport * as fs from "node:fs/promises";\nconst logPath = process.env.SPELL_TEST_ORG_LOG;\nif (logPath) {\n\tawait fs.writeFile(logPath, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n}\nprocess.exit(Number(process.env.SPELL_TEST_ORG_EXIT_CODE ?? "0"));\n`,
		);
		await fs.chmod(spellPath, 0o755);
	}
	Bun.env.PATH = `${binDir}:${previousPath ?? ""}`;
	process.chdir(root);
	return { root, logPath, spellPath };
}

async function readInvocation(logPath: string): Promise<{ argv: string[]; cwd: string }> {
	return JSON.parse(await Bun.file(logPath).text()) as { argv: string[]; cwd: string };
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

describe("OrgHookExecutor", () => {
	it("creates a BUG org item for failed goals", async () => {
		const { logPath, root, spellPath } = await createWorkspace();
		const executor = new OrgHookExecutor({ spellBinary: spellPath, cwd: root });

		await executor.execute({ type: "org" }, FAILURE_RESULT, BASE_CONTEXT);

		const invocation = await readInvocation(logPath);
		expect(invocation.cwd).toBe(root);
		expect(invocation.argv).toEqual(expect.arrayContaining(["org", "create", "category=BUG"]));
		expect(invocation.argv.find(arg => arg.startsWith("title="))).toBe("title=Goal failure: nightly");
		const bodyArg = invocation.argv.find(arg => arg.startsWith("body="));
		expect(bodyArg).toContain("Goal: nightly");
		expect(bodyArg).toContain("Error:");
		expect(bodyArg).toContain("rpc blew up");
		expect(bodyArg).toContain("nightly-1");
	});

	it("creates a categorized org item for successful goals", async () => {
		const { logPath, root, spellPath } = await createWorkspace();
		const executor = new OrgHookExecutor({ spellBinary: spellPath, cwd: root });
		const target: OrgHook = { type: "org", category: "features" };

		await executor.execute(target, SUCCESS_RESULT, BASE_CONTEXT);

		const invocation = await readInvocation(logPath);
		expect(invocation.argv).toEqual(expect.arrayContaining(["org", "create", "category=features"]));
		expect(invocation.argv.find(arg => arg.startsWith("title="))).toBe("title=Goal success: nightly");
		expect(invocation.argv.find(arg => arg.startsWith("body="))).toContain("All checks passed");
	});

	it("skips gracefully when the spell CLI is unavailable", async () => {
		const { logPath, root } = await createWorkspace({ installSpell: false });
		const executor = new OrgHookExecutor({ spellBinary: null, cwd: root });

		await expect(
			executor.execute({ type: "org", category: "BUG" }, FAILURE_RESULT, BASE_CONTEXT),
		).resolves.toBeUndefined();
		expect(await pathExists(logPath)).toBe(false);
	});

	it("does not propagate org creation failures", async () => {
		const { logPath, root, spellPath } = await createWorkspace({ spellExitCode: 7 });
		const executor = new OrgHookExecutor({ spellBinary: spellPath, cwd: root });

		await expect(
			executor.execute({ type: "org", category: "BUG" }, FAILURE_RESULT, BASE_CONTEXT),
		).resolves.toBeUndefined();
		expect(await pathExists(logPath)).toBe(true);
	});
});

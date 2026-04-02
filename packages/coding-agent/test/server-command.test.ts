import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveDefaultConfigDir } from "../src/commands/server";

const CLI_PATH = path.resolve(import.meta.dir, "../src/cli.ts");

const VALID_SERVER_KDL = `http {
	port 0
	auth {
		username "spell"
		password "secret" // pragma: allowlist secret
	}
	webhook-secret "webhook-secret" // pragma: allowlist secret
	goal-token "incoming" "goal-token"
}
`;

const VALID_MANIFEST_KDL = `name "spell-server"
version "1.0.0"
setup "default" {
	domain "coding"
	mode "worker"
}
goal "nightly" {
	setup "default"
	schedule type="cron" expression="0 0 1 1 *"
	prompt "Run nightly checks."
}
`;

const VALID_CHANNELS_KDL = `telegram {
	bot-token "123456:ABC-DEF"
	default-model "claude-sonnet-4-5"
	owners 12345
}
`;

const tempDirs = new Set<string>();

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.allSettled(
		[...tempDirs].map(async tempDir => {
			tempDirs.delete(tempDir);
			await fs.rm(tempDir, { recursive: true, force: true });
		}),
	);
});

describe("server command config discovery", () => {
	it("falls back to ~/.spell when the workspace has no .spell directory", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-server-command-"));
		tempDirs.add(tempDir);
		const workspaceDir = path.join(tempDir, "workspace");
		const homeDir = path.join(tempDir, "home");
		await fs.mkdir(workspaceDir, { recursive: true });
		await fs.mkdir(homeDir, { recursive: true });
		await writeConfigDir(path.join(homeDir, ".spell"), {
			"server.kdl": VALID_SERVER_KDL,
			"autonomy.kdl": VALID_MANIFEST_KDL,
			"channels.kdl": VALID_CHANNELS_KDL,
		});

		const process = spawnServerCommand(workspaceDir, homeDir);
		try {
			await expectProcessToKeepRunning(process);
		} finally {
			process.kill("SIGTERM");
			expect([0, 143]).toContain(await process.exited);
		}
	});

	it("prefers ./.spell over ~/.spell when both exist", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-server-command-"));
		tempDirs.add(tempDir);
		const workspaceDir = path.join(tempDir, "workspace");
		const homeDir = path.join(tempDir, "home");
		await fs.mkdir(workspaceDir, { recursive: true });
		await fs.mkdir(homeDir, { recursive: true });
		await writeConfigDir(path.join(workspaceDir, ".spell"), {
			"server.kdl": VALID_SERVER_KDL,
			"autonomy.kdl": VALID_MANIFEST_KDL,
			"channels.kdl": VALID_CHANNELS_KDL,
		});
		await writeConfigDir(path.join(homeDir, ".spell"), {
			"server.kdl": VALID_SERVER_KDL,
		});

		const process = spawnServerCommand(workspaceDir, homeDir);
		try {
			await expectProcessToKeepRunning(process);
		} finally {
			process.kill("SIGTERM");
			expect([0, 143]).toContain(await process.exited);
		}
	});

	it("keeps stderr quiet by default", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-server-command-"));
		tempDirs.add(tempDir);
		const workspaceDir = path.join(tempDir, "workspace");
		const homeDir = path.join(tempDir, "home");
		await fs.mkdir(workspaceDir, { recursive: true });
		await fs.mkdir(homeDir, { recursive: true });
		await writeConfigDir(path.join(homeDir, ".spell"), {
			"server.kdl": VALID_SERVER_KDL,
			"autonomy.kdl": VALID_MANIFEST_KDL,
			"channels.kdl": VALID_CHANNELS_KDL,
		});

		const process = spawnServerCommand(workspaceDir, homeDir);
		try {
			await expectProcessToKeepRunning(process);
			await Bun.sleep(700);
		} finally {
			process.kill("SIGTERM");
		}

		expect([0, 143]).toContain(await process.exited);
		expect(await readPipe(process.stderr)).toBe("");
	});

	it("mirrors debug logs to stderr when --debug is set", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-server-command-"));
		tempDirs.add(tempDir);
		const workspaceDir = path.join(tempDir, "workspace");
		const homeDir = path.join(tempDir, "home");
		await fs.mkdir(workspaceDir, { recursive: true });
		await fs.mkdir(homeDir, { recursive: true });
		await writeConfigDir(path.join(homeDir, ".spell"), {
			"server.kdl": VALID_SERVER_KDL,
			"autonomy.kdl": VALID_MANIFEST_KDL,
			"channels.kdl": VALID_CHANNELS_KDL,
		});

		const process = spawnServerCommand(workspaceDir, homeDir, ["--debug"]);
		try {
			await expectProcessToKeepRunning(process);
			await Bun.sleep(700);
		} finally {
			process.kill("SIGTERM");
		}

		expect([0, 143]).toContain(await process.exited);
		const stderr = await readPipe(process.stderr);
		expect(stderr).toContain('"message":"Spell server running"');
		expect(stderr).toContain('"message":"Shutting down spell server"');
	});
});

describe("resolveDefaultConfigDir", () => {
	it("falls back to ~/.spell on ENOENT from ./.spell", async () => {
		const homeDir = "/tmp/home-spell";
		vi.spyOn(process, "cwd").mockReturnValue("/tmp/workspace");
		vi.spyOn(os, "homedir").mockReturnValue(homeDir);
		vi.spyOn(fs, "stat").mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));

		await expect(resolveDefaultConfigDir()).resolves.toBe(path.join(homeDir, ".spell"));
	});

	it("rethrows non-ENOENT errors from ./.spell stat", async () => {
		const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
		vi.spyOn(process, "cwd").mockReturnValue("/tmp/workspace");
		vi.spyOn(fs, "stat").mockRejectedValue(failure);

		await expect(resolveDefaultConfigDir()).rejects.toBe(failure);
	});
});

function spawnServerCommand(
	cwd: string,
	homeDir: string,
	extraArgs: string[] = [],
): Bun.Subprocess<"ignore", "pipe", "pipe"> {
	return Bun.spawn([process.execPath, CLI_PATH, "server", ...extraArgs], {
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
}

async function expectProcessToKeepRunning(process: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<void> {
	const earlyExit = await Promise.race([
		process.exited.then(code => ({ type: "exited" as const, code })),
		Bun.sleep(400).then(() => ({ type: "running" as const })),
	]);
	if (earlyExit.type === "running") {
		return;
	}
	const stdout = await readPipe(process.stdout);
	const stderr = await readPipe(process.stderr);
	throw new Error(`server command exited early with code ${earlyExit.code}: stdout=${stdout} stderr=${stderr}`);
}

async function readPipe(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) {
		return "";
	}
	return await new Response(stream).text();
}

async function writeConfigDir(configDir: string, files: Record<string, string>): Promise<void> {
	await fs.mkdir(configDir, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		await Bun.write(path.join(configDir, name), content);
	}
}

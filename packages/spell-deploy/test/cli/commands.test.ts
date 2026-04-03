import { afterEach, beforeEach, describe, expect, it, mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SyncConfig, SyncTarget } from "../../src/config/types";

async function createTestProject(): Promise<string> {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-deploy-test-"));
	const spellDir = path.join(tmpDir, ".spell");
	await fs.mkdir(spellDir, { recursive: true });
	await Bun.write(
		path.join(spellDir, "sync.kdl"),
		`default-target "test"
target "test" {
  host "test.example.com"
  user "spell"
  project-root "/srv/spell/test"
  service type="systemd" unit="spell-test"
  secrets ".spell/test.env.age"
}
`,
	);
	return tmpDir;
}

async function importCommands(tag: string) {
	return import(`../../src/cli/commands?${tag}-${Date.now()}`);
}

const config: SyncConfig = {
	defaultTarget: "test",
	targets: new Map(),
	sync: {
		pushDebounce: "2s",
		pull: [],
		pullInterval: "30s",
	},
	bundle: {
		platform: "linux-x64",
		cacheDir: ".spell/bundle-cache/",
	},
};

const target: SyncTarget = {
	name: "test",
	host: "test.example.com",
	user: "spell",
	port: 22,
	projectRoot: "/srv/spell/test",
	service: { type: "systemd", unit: "spell-test" },
	secrets: ".spell/test.env.age",
	include: [],
	exclude: [],
};

/** Stub Bun.which to return a path for sqlite3-rsync */
function stubSqlite3Rsync() {
	const original = Bun.which;
	vi.spyOn(Bun, "which").mockImplementation((cmd, ...args) => {
		if (cmd === "sqlite3-rsync") return "/usr/bin/sqlite3-rsync";
		return original.call(Bun, cmd, ...args);
	});
}

describe("cli commands", () => {
	let tempDirs: string[];

	beforeEach(() => {
		tempDirs = [];
		vi.restoreAllMocks();
		mock.restore();
	});

	afterEach(async () => {
		mock.restore();
		vi.restoreAllMocks();
		await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
	});

	it("resolveContext resolves target from sync.kdl", async () => {
		const tmpDir = await createTestProject();
		tempDirs.push(tmpDir);
		const { resolveContext } = await importCommands("resolve-success");

		const { context, target } = await resolveContext({
			projectRoot: tmpDir,
			dryRun: false,
		});

		expect(context.targetName).toBe("test");
		expect(target.host).toBe("test.example.com");
	});

	it("resolveContext throws for unknown target with available list", async () => {
		const tmpDir = await createTestProject();
		tempDirs.push(tmpDir);
		const { resolveContext } = await importCommands("resolve-missing-target");

		await expect(resolveContext({ projectRoot: tmpDir, targetName: "nonexistent", dryRun: false })).rejects.toThrow(
			/Available: test/,
		);
	});

	it("resolveContext throws with helpful message when sync.kdl missing", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-deploy-test-"));
		tempDirs.push(tmpDir);
		const { resolveContext } = await importCommands("resolve-missing-config");

		await expect(resolveContext({ projectRoot: tmpDir, dryRun: false })).rejects.toThrow(/sync\.kdl/);
	});

	it("requireSqlite3Rsync throws when binary is missing", async () => {
		vi.spyOn(Bun, "which").mockReturnValue(null);
		const { requireSqlite3Rsync } = await importCommands("require-check");

		expect(() => requireSqlite3Rsync()).toThrow("sqlite3-rsync binary not found");
	});

	it("pushCommand orchestrates stop, push, start in order", async () => {
		stubSqlite3Rsync();
		const steps: string[] = [];
		mock.module("../../src/service/lifecycle", () => ({
			buildServiceCommand: (_sshOptions: unknown, unitName: string, action: string) => ({
				args: [],
				description: `${action}:${unitName}`,
			}),
			serviceAction: async (_sshOptions: unknown, unitName: string, action: string) => {
				steps.push(`${action}:${unitName}`);
			},
			buildInstallUnitCommand: () => ({
				args: ["ssh"],
				stdin: "",
				description: "install unit",
			}),
		}));
		mock.module("../../src/sync/push", () => ({
			buildPushPlan: () => ({
				rsyncToStaging: { args: [], description: "rsync push" },
				swapCommands: [],
				sqliteRsyncCommands: [],
			}),
			executePush: async (opts: { target: { name: string } }) => {
				steps.push(`push:${opts.target.name}`);
			},
		}));
		const { pushCommand } = await importCommands("push-order");

		await pushCommand({ projectRoot: "/workspace/app", targetName: "test", dryRun: false }, config, target);

		expect(steps).toEqual(["stop:spell-test", "push:test", "start:spell-test"]);
	});

	it("bootstrapCommand runs init, secrets, push in sequence", async () => {
		stubSqlite3Rsync();
		const steps: string[] = [];
		mock.module("../../src/sync/ssh", () => ({
			sshOptionsFromTarget: () => ({ host: "test.example.com", user: "spell", port: 22, connectTimeout: 10 }),
			buildSshCommand: () => ({ args: ["ssh"], description: "mkdir" }),
			execSsh: async () => {
				steps.push("init");
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		}));
		mock.module("../../src/secrets/age", () => ({
			decryptAge: async () => "KEY=value\n",
		}));
		mock.module("../../src/secrets/push", () => ({
			executeSecretPush: async () => {
				steps.push("secrets");
			},
		}));
		mock.module("../../src/service/lifecycle", () => ({
			buildServiceCommand: () => ({ args: [], description: "service" }),
			serviceAction: async () => {},
			buildInstallUnitCommand: () => ({ args: ["true"], stdin: "", description: "install unit" }),
		}));
		mock.module("../../src/sync/push", () => ({
			buildPushPlan: () => ({
				rsyncToStaging: { args: [], description: "rsync push" },
				swapCommands: [],
				sqliteRsyncCommands: [],
			}),
			executePush: async () => {
				steps.push("push");
			},
		}));
		const { bootstrapCommand } = await importCommands("bootstrap-order");

		await bootstrapCommand({ projectRoot: "/workspace/app", targetName: "test", dryRun: false }, config, target);

		expect(steps).toEqual(["init", "secrets", "push"]);
	});

	it("main routes push and forwards parsed options", async () => {
		const calls: string[] = [];
		mock.module("../../src/cli/commands", () => ({
			resolveContext: async (opts: { projectRoot?: string; targetName?: string; dryRun: boolean }) => {
				calls.push(`resolve:${opts.projectRoot}:${opts.targetName}:${String(opts.dryRun)}`);
				return {
					context: {
						projectRoot: opts.projectRoot ?? "/workspace/app",
						targetName: opts.targetName ?? "test",
						dryRun: opts.dryRun,
					},
					config,
					target,
				};
			},
			initCommand: async () => {},
			pushCommand: async () => {
				calls.push("push");
			},
			pullCommand: async () => {},
			statusCommand: async () => ({ serviceRunning: true, healthOk: true }),
			secretsCommand: async () => {},
			watchCommand: () => ({ start() {}, stop() {} }),
			bootstrapCommand: async () => {},
			requireSqlite3Rsync: () => {},
		}));
		const { main } = await import(`../../src/cli/main?main-route-${Date.now()}`);

		await main(["push", "prod", "--cwd", "/tmp/project", "--dry-run"]);

		expect(calls).toEqual(["resolve:/tmp/project:prod:true", "push"]);
	});
});

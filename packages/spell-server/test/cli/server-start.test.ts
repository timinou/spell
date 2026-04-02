import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../../src/config/loader";
import { startSpellServer } from "../../src/server";

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
	owners 12345 67890
}
`;

afterEach(async () => {
	await cleanupTempDirs();
});

describe("spell-server config loading", () => {
	it("loads server, manifest, and optional telegram channel config", async () => {
		const configDir = await createConfigDir({
			"server.kdl": VALID_SERVER_KDL,
			"autonomy.kdl": VALID_MANIFEST_KDL,
			"channels.kdl": VALID_CHANNELS_KDL,
		});

		const loaded = await loadConfig(configDir);

		expect(loaded.server).toEqual({
			http: {
				port: 0,
				auth: { username: "spell", password: "secret" }, // pragma: allowlist secret
				webhookSecret: "webhook-secret", // pragma: allowlist secret
				goalTokens: { incoming: "goal-token" },
			},
		});
		expect(loaded.channels).toEqual({
			telegram: {
				botToken: "123456:ABC-DEF",
				owners: [12345, 67890],
				uploadDir: "/tmp/spell-telegram-uploads",
				idleTimeout: 300,
				maxSessions: 10,
				logViewerPort: undefined,
				defaultModel: "claude-sonnet-4-5",
				defaultProject: undefined,
				projects: {},
				users: {},
			},
		});
		expect(loaded.manifest.goals.has("nightly")).toBe(true);
	});

	it("rejects telegram channel config without default-model", async () => {
		const configDir = await createConfigDir({
			"server.kdl": VALID_SERVER_KDL,
			"autonomy.kdl": VALID_MANIFEST_KDL,
			"channels.kdl": `telegram {
				bot-token "123456:ABC-DEF"
				owners 12345
			}`,
		});

		await expect(loadConfig(configDir)).rejects.toThrow(
			"Failed to load channels.kdl: channels.telegram.default-model is required",
		);
	});

	it("allows channels.kdl to be omitted", async () => {
		const configDir = await createConfigDir({
			"server.kdl": VALID_SERVER_KDL,
			"autonomy.kdl": VALID_MANIFEST_KDL,
		});

		const loaded = await loadConfig(configDir);

		expect(loaded.channels).toEqual({});
	});

	it("reports missing autonomy.kdl as a required config error", async () => {
		const configDir = await createConfigDir({ "server.kdl": VALID_SERVER_KDL });

		await expect(loadConfig(configDir)).rejects.toThrow(
			`Missing required config file: ${path.join(configDir, "autonomy.kdl")}`,
		);
	});

	it("reports manifest validation failures", async () => {
		const configDir = await createConfigDir({
			"server.kdl": VALID_SERVER_KDL,
			"autonomy.kdl": `name "broken"
version "1.0.0"
setup "default" { domain "coding" }
goal "nightly" {
	setup "missing"
	schedule type="cron" expression="0 0 1 1 *"
	prompt "Run nightly checks."
}
`,
		});

		await expect(loadConfig(configDir)).rejects.toThrow(/Unknown setup/);
	});
});

describe("spell-server startup", () => {
	it("cleans stale sandbox policy files on startup", async () => {
		const configDir = await createConfigDir({
			"server.kdl": VALID_SERVER_KDL,
			"autonomy.kdl": VALID_MANIFEST_KDL,
		});
		const stalePolicyPath = path.join(os.tmpdir(), `spell-sandbox-999999-stale-${Date.now()}.json`);
		await Bun.write(stalePolicyPath, "{}");
		const config = await loadConfig(configDir);
		const server = await startSpellServer(config, process.cwd());
		try {
			await expect(fs.access(stalePolicyPath)).rejects.toThrow();
		} finally {
			await server.stop();
			await fs.rm(stalePolicyPath, { force: true });
		}
	});
});

describe("spell-server CLI", () => {
	it("starts from main.ts and shuts down on SIGTERM", async () => {
		const configDir = await createConfigDir({
			"server.kdl": VALID_SERVER_KDL,
			"autonomy.kdl": VALID_MANIFEST_KDL,
		});
		const process = Bun.spawn(["bun", "run", "src/main.ts", "--config-dir", configDir], {
			cwd: path.join(import.meta.dir, "..", ".."),
			stdout: "pipe",
			stderr: "pipe",
		});

		const earlyExit = await Promise.race([
			process.exited.then(code => ({ type: "exited" as const, code })),
			Bun.sleep(400).then(() => ({ type: "running" as const })),
		]);
		if (earlyExit.type === "exited") {
			const stdout = await new Response(process.stdout).text();
			const stderr = await new Response(process.stderr).text();
			throw new Error(`CLI exited early with code ${earlyExit.code}: stdout=${stdout} stderr=${stderr}`);
		}

		process.kill("SIGTERM");
		expect([0, 143]).toContain(await process.exited);
	});

	it("exits with code 1 when required config is missing", async () => {
		const configDir = await createConfigDir({ "server.kdl": VALID_SERVER_KDL });
		const process = Bun.spawn(["bun", "run", "src/main.ts", "--config-dir", configDir], {
			cwd: path.join(import.meta.dir, "..", ".."),
			stdout: "pipe",
			stderr: "pipe",
		});

		expect(await process.exited).toBe(1);
	});
});

const tempDirs = new Set<string>();

async function createConfigDir(files: Record<string, string>): Promise<string> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-server-cli-"));
	tempDirs.add(tempDir);
	for (const [name, content] of Object.entries(files)) {
		await Bun.write(path.join(tempDir, name), content);
	}
	return tempDir;
}

async function cleanupTempDirs(): Promise<void> {
	await Promise.allSettled(
		[...tempDirs].map(async tempDir => {
			tempDirs.delete(tempDir);
			await fs.rm(tempDir, { recursive: true, force: true });
		}),
	);
}

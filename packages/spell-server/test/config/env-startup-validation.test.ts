import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../../src/config/loader";

const MANIFEST_KDL = `name "test-server"
version "1.0.0"
setup "default" {
	domain "coding"
	mode "worker"
}
goal "nightly" {
	setup "default"
	schedule type="cron" expression="0 0 1 1 *"
	prompt "Run checks."
}
`;

const tempDirs = new Set<string>();

afterEach(async () => {
	await Promise.allSettled(
		[...tempDirs].map(async dir => {
			tempDirs.delete(dir);
			await fs.rm(dir, { recursive: true, force: true });
		}),
	);
});

async function createConfigDir(files: Record<string, string>): Promise<string> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-env-test-"));
	tempDirs.add(tempDir);
	for (const [name, content] of Object.entries(files)) {
		const filePath = path.join(tempDir, name);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await Bun.write(filePath, content);
	}
	return tempDir;
}

describe("startup env validation", () => {
	it("loads config with dotenv enabled and all vars present", async () => {
		const configDir = await createConfigDir({
			"server.kdl": `dotenv #true
http {
	port 8787
	auth {
		username "admin"
		password "env(TEST_HTTP_PASSWORD)"
	}
}
`,
			"autonomy.kdl": MANIFEST_KDL,
			".env": "TEST_HTTP_PASSWORD=secret123", // pragma: allowlist secret
		});

		const config = await loadConfig(configDir);
		expect(config.server.http.auth.password).toBe("secret123");
		expect(config.server.http.port).toBe(8787);
	});

	it("fails with actionable error when required env var is missing", async () => {
		const configDir = await createConfigDir({
			"server.kdl": `dotenv #true
http {
	port 8787
	auth {
		username "admin"
		password "env(MISSING_PASSWORD)"
	}
	webhook-secret "env(MISSING_SECRET)"
}
`,
			"autonomy.kdl": MANIFEST_KDL,
			".env": "",
		});

		await expect(loadConfig(configDir)).rejects.toThrow(/Missing.*required environment variable/);
	});

	it("reports all missing vars, not just the first", async () => {
		const configDir = await createConfigDir({
			"server.kdl": `dotenv #true
http {
	port 8787
	auth {
		username "admin"
		password "env(MISSING_A)"
	}
	webhook-secret "env(MISSING_B)"
}
`,
			"autonomy.kdl": MANIFEST_KDL,
			".env": "",
		});

		try {
			await loadConfig(configDir);
			throw new Error("should have thrown");
		} catch (err) {
			const message = (err as Error).message;
			expect(message).toContain("Missing 2 required environment variables");
		}
	});

	it("uses default values for env vars with defaults", async () => {
		const configDir = await createConfigDir({
			"server.kdl": `dotenv #true
http {
	port 8787
	auth {
		username "admin"
		password "env(TEST_PW, default=default-pw)"
	}
}
`,
			"autonomy.kdl": MANIFEST_KDL,
			".env": "",
		});

		const config = await loadConfig(configDir);
		expect(config.server.http.auth.password).toBe("default-pw");
	});

	it("scans channels.kdl env refs when dotenv enabled", async () => {
		const configDir = await createConfigDir({
			"server.kdl": `dotenv #true
http {
	port 8787
	auth {
		username "admin"
		password "admin-pass"
	}
}
`,
			"channels.kdl": `telegram {
	bot-token "env(MISSING_BOT_TOKEN)"
	default-model "claude-sonnet-4-5"
	owners 12345
}
`,
			"autonomy.kdl": MANIFEST_KDL,
			".env": "",
		});

		await expect(loadConfig(configDir)).rejects.toThrow(/Missing.*required environment variable/);
	});

	it("works without dotenv node (backward compat)", async () => {
		const configDir = await createConfigDir({
			"server.kdl": `http {
	port 8787
	auth {
		username "admin"
		password "secret"
	}
}
`,
			"autonomy.kdl": MANIFEST_KDL,
		});

		const config = await loadConfig(configDir);
		expect(config.server.http.port).toBe(8787);
		expect(config.server.http.auth.password).toBe("secret");
	});

	it("loads .env from custom path", async () => {
		const configDir = await createConfigDir({
			"server.kdl": `dotenv "./secrets/.env"
http {
	port 8787
	auth {
		username "admin"
		password "env(CUSTOM_PW)"
	}
}
`,
			"autonomy.kdl": MANIFEST_KDL,
			"secrets/.env": "CUSTOM_PW=from-custom-path",
		});

		const config = await loadConfig(configDir);
		expect(config.server.http.auth.password).toBe("from-custom-path");
	});

	it("continues when .env file is missing but dotenv is enabled", async () => {
		// No .env file at all, but server.kdl has dotenv true
		// and no env() references — should succeed
		const configDir = await createConfigDir({
			"server.kdl": `dotenv #true
http {
	port 8787
	auth {
		username "admin"
		password "literal-password"
	}
}
`,
			"autonomy.kdl": MANIFEST_KDL,
		});

		const config = await loadConfig(configDir);
		expect(config.server.http.port).toBe(8787);
	});

	it("scans autonomy.kdl import directives for env refs", async () => {
		const configDir = await createConfigDir({
			"server.kdl": `dotenv #true
http {
	port 8787
	auth {
		username "admin"
		password "literal-password"
	}
}
`,
			"autonomy.kdl": `name "test"
version "1.0.0"
import "./custom-actions.kdl" as="custom"
setup "default" {
	domain "coding"
	mode "worker"
}
goal "nightly" {
	setup "default"
	schedule type="cron" expression="0 0 1 1 *"
	prompt "Run checks."
}
`,
			"custom-actions.kdl": `action "deploy" {
	api-key "env(MISSING_DEPLOY_KEY)"
}
`,
			".env": "",
		});

		await expect(loadConfig(configDir)).rejects.toThrow(/Missing.*required environment variable/);
	});
});

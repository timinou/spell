/**
 * Startup matrix \u2014 PLAN-311 WAVE 7 verification.
 *
 * Exercises end-to-end the 5 scenarios the plan called out:
 *   (a) no config       \u2192 defaults render, no files created
 *   (b) legacy YAML only\u2192 migrator translates with `migrate: { yes: true }`,
 *                         settings visible on same launch, .bak left
 *   (c) decline migration\u2192 KDL loaded if exists, else defaults; orphans
 *                         remain untouched
 *   (d) KDL only         \u2192 clean load, no migration noise
 *   (e) all 3 KDL tiers  \u2192 precedence: local > project > user
 *
 * Plus the integrated absorption coverage from earlier waves:
 *   - secrets, mcp.servers, ssh.hosts, domain all sourced from spell.kdl
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _resetSettingsForTest, Settings } from "@spell/pi-coding-agent/config/settings";
import { Snowflake } from "@spell/pi-utils";

let tmp: string;
let agentDir: string;
let projectDir: string;
let userKdl: string;
let projectKdl: string;
let localKdl: string;

function opts(extra: Record<string, unknown> = {}) {
	return {
		cwd: projectDir,
		agentDir,
		userKdlPath: userKdl,
		projectKdlPath: projectKdl,
		localKdlPath: localKdl,
		...extra,
	};
}

beforeEach(() => {
	_resetSettingsForTest();
	tmp = path.join(os.tmpdir(), "startup-matrix", Snowflake.next());
	agentDir = path.join(tmp, ".spell", "agent");
	projectDir = path.join(tmp, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
	userKdl = path.join(tmp, "user-config", "spell.kdl");
	projectKdl = path.join(projectDir, "spell.kdl");
	localKdl = path.join(projectDir, ".local", "spell.kdl");
});

afterEach(() => {
	if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true });
});

describe("(a) no config — defaults", () => {
	it("Settings.init with empty directories returns schema defaults", async () => {
		const s = await Settings.init(opts());
		// defaultThinkingLevel default is "high" per schema
		expect(s.get("defaultThinkingLevel")).toBe("high");
		expect(s.get("secrets")).toEqual([]);
		expect(s.get("mcp.servers")).toEqual({});
		expect(s.get("ssh.hosts")).toEqual({});

		// No KDL files materialized just by reading.
		expect(fs.existsSync(userKdl)).toBe(false);
		expect(fs.existsSync(projectKdl)).toBe(false);
		expect(fs.existsSync(localKdl)).toBe(false);
	});
});

describe("(b) legacy YAML only — migration on demand", () => {
	it("config.yml at user tier translates to user spell.kdl with migrate.yes", async () => {
		fs.writeFileSync(path.join(agentDir, "config.yml"), "defaultThinkingLevel: medium\n");
		const s = await Settings.init({ ...opts(), migrate: { yes: true } });
		expect(s.get("defaultThinkingLevel")).toBe("medium");
		expect(fs.existsSync(userKdl)).toBe(true);
		// .bak file replaces original.
		expect(fs.existsSync(path.join(agentDir, "config.yml"))).toBe(false);
	});

	it("settings.json at project tier translates to project spell.kdl", async () => {
		fs.mkdirSync(path.join(projectDir, ".spell"), { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, ".spell", "settings.json"),
			JSON.stringify({ theme: { dark: "anthracite" } }),
		);
		const s = await Settings.init({ ...opts(), migrate: { yes: true } });
		expect(s.get("theme.dark")).toBe("anthracite");
		expect(fs.existsSync(projectKdl)).toBe(true);
	});
});

describe("(c) decline migration — orphans preserved", () => {
	it("legacy file present + migrate.no leaves source untouched and uses defaults", async () => {
		const legacy = path.join(agentDir, "config.yml");
		fs.writeFileSync(legacy, "defaultThinkingLevel: low\n");

		const s = await Settings.init({ ...opts(), migrate: { no: true } });
		// Schema default applies (file is untouched, not read as a legacy fallback for KDL).
		expect(s.get("defaultThinkingLevel")).toBe("high");
		expect(fs.existsSync(legacy)).toBe(true);
		expect(fs.existsSync(userKdl)).toBe(false);
	});
});

describe("(d) KDL only — clean load", () => {
	it("hand-written spell.kdl loads cleanly with no migration files", async () => {
		fs.mkdirSync(path.dirname(userKdl), { recursive: true });
		fs.writeFileSync(userKdl, 'model {\n  thinking "low"\n}\n');
		const s = await Settings.init(opts());
		expect(s.get("defaultThinkingLevel")).toBe("low");
	});
});

describe("(e) all 3 KDL tiers — precedence local > project > user", () => {
	it("local overrides project overrides user for the same key", async () => {
		fs.mkdirSync(path.dirname(userKdl), { recursive: true });
		fs.mkdirSync(path.dirname(localKdl), { recursive: true });
		fs.writeFileSync(userKdl, 'model {\n  thinking "low"\n}\n');
		fs.writeFileSync(projectKdl, 'model {\n  thinking "medium"\n}\n');
		fs.writeFileSync(localKdl, 'model {\n  thinking "high"\n}\n');

		const s = await Settings.init(opts());
		expect(s.get("defaultThinkingLevel")).toBe("high");
	});

	it("user tier visible when local and project don't define the key", async () => {
		fs.mkdirSync(path.dirname(userKdl), { recursive: true });
		fs.writeFileSync(userKdl, 'appearance {\n  theme dark="anthracite"\n}\n');
		fs.writeFileSync(projectKdl, 'model {\n  thinking "medium"\n}\n');

		const s = await Settings.init(opts());
		expect(s.get("theme.dark")).toBe("anthracite");
		expect(s.get("defaultThinkingLevel")).toBe("medium");
	});
});

describe("integration: all magic-file replacements coexist in one launch", () => {
	it("secrets + mcp + ssh + domain all sourced from spell.kdl after migration", async () => {
		// Drop one of each magic legacy file.
		fs.writeFileSync(path.join(agentDir, "secrets.yml"), "- type: plain\n  content: SECRET_X\n");
		fs.writeFileSync(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { memory: { type: "stdio", command: "mcp-memory" } } }),
		);
		fs.writeFileSync(
			path.join(agentDir, "ssh.json"),
			JSON.stringify({ hosts: { prod: { host: "prod.example.com", port: "22" } } }),
		);
		fs.mkdirSync(path.join(projectDir, ".spell"), { recursive: true });
		fs.writeFileSync(path.join(projectDir, ".spell", "domain.json"), JSON.stringify({ domain: "research" }));

		const s = await Settings.init({ ...opts(), migrate: { yes: true } });

		// All four absorbed.
		expect((s.get("secrets") as Array<Record<string, unknown>>)[0]?.content).toBe("SECRET_X");
		expect((s.get("mcp.servers") as Record<string, Record<string, unknown>>).memory.command).toBe("mcp-memory");
		const sshHosts = s.get("ssh.hosts") as Record<string, Record<string, unknown>>;
		expect(sshHosts.prod.host).toBe("prod.example.com");
		expect(sshHosts.prod.port).toBe(22); // coerced from string
		expect(s.get("domain")).toBe("research");

		// All legacy files .bak'd.
		expect(fs.existsSync(path.join(agentDir, "secrets.yml"))).toBe(false);
		expect(fs.existsSync(path.join(agentDir, "mcp.json"))).toBe(false);
		expect(fs.existsSync(path.join(agentDir, "ssh.json"))).toBe(false);
		expect(fs.existsSync(path.join(projectDir, ".spell", "domain.json"))).toBe(false);

		// And the KDL destinations exist with the absorbed content.
		const userContent = fs.readFileSync(userKdl, "utf8");
		const projectContent = fs.readFileSync(projectKdl, "utf8");
		expect(userContent).toMatch(/secrets/);
		expect(userContent).toMatch(/mcp/);
		expect(userContent).toMatch(/ssh/);
		expect(projectContent).toMatch(/domain/);
	});

	it("re-running after migration is a no-op (idempotent)", async () => {
		fs.writeFileSync(path.join(agentDir, "secrets.yml"), "- type: plain\n  content: X\n");
		await Settings.init({ ...opts(), migrate: { yes: true } });

		_resetSettingsForTest();
		// Second launch should be quiet \u2014 .bak sibling guards re-prompting.
		const s = await Settings.init(opts());
		expect((s.get("secrets") as Array<Record<string, unknown>>)[0]?.content).toBe("X");
	});
});

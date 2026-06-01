/**
 * End-to-end: SSH host config sourced from spell.kdl.
 *
 * Covers WAVE 2.6 of PLAN-311:
 *   - spell.kdl `ssh { target ... }` block round-trips through Settings
 *   - Per-tier merge: project-tier wins over user-tier on same name (with warning)
 *   - Migrator translates legacy ssh.json {hosts:{...}} into the block
 *   - 3 legacy locations covered: ~/.spell/agent, <cwd>/.spell, <cwd>
 *   - Pre-existing spell.kdl entries are NOT clobbered (manual edits win)
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

function opts() {
	return { cwd: projectDir, agentDir, userKdlPath: userKdl, projectKdlPath: projectKdl, localKdlPath: localKdl };
}

beforeEach(() => {
	_resetSettingsForTest();
	tmp = path.join(os.tmpdir(), "ssh-kdl", Snowflake.next());
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

describe("ssh.hosts ← spell.kdl", () => {
	it("Settings round-trip preserves all host fields", async () => {
		const s = await Settings.init(opts());
		s.set(
			"ssh.hosts" as never,
			{
				prod: {
					host: "prod.example.com",
					username: "deploy",
					port: 22,
					keyPath: "~/.ssh/prod",
					description: "Production",
					compat: true,
				},
				staging: {
					host: "staging.example.com",
					username: "deploy",
				},
			} as never,
		);
		await s.flush();

		_resetSettingsForTest();
		const s2 = await Settings.init(opts());
		const got = s2.get("ssh.hosts" as never) as Record<string, Record<string, unknown>>;
		expect(got.prod).toMatchObject({
			host: "prod.example.com",
			username: "deploy",
			port: 22,
			keyPath: "~/.ssh/prod",
			description: "Production",
			compat: true,
		});
		expect(got.staging).toMatchObject({
			host: "staging.example.com",
			username: "deploy",
		});
	});

	it("hand-written KDL with `target` nodes reads back via Settings", async () => {
		fs.mkdirSync(path.dirname(userKdl), { recursive: true });
		fs.writeFileSync(
			userKdl,
			'ssh {\n  target "alpha" hostname="alpha.test" username="u" port=2222\n  target "beta" hostname="beta.test"\n}\n',
		);
		const s = await Settings.init(opts());
		const got = s.get("ssh.hosts" as never) as Record<string, Record<string, unknown>>;
		expect(got.alpha).toMatchObject({ host: "alpha.test", username: "u", port: 2222 });
		expect(got.beta).toMatchObject({ host: "beta.test" });
	});

	it("unknown nodes inside ssh block are ignored with warning", async () => {
		fs.mkdirSync(path.dirname(userKdl), { recursive: true });
		fs.writeFileSync(
			userKdl,
			'ssh {\n  unrecognized "ignored"\n  target "ok" hostname="ok.test"\n}\n',
		);
		const s = await Settings.init(opts());
		const got = s.get("ssh.hosts" as never) as Record<string, unknown>;
		expect(got).toHaveProperty("ok");
		expect(got).not.toHaveProperty("unrecognized");
	});

	it("legacy alias: `host`/`user`/`keyPath` props still accepted", async () => {
		fs.mkdirSync(path.dirname(userKdl), { recursive: true });
		fs.writeFileSync(
			userKdl,
			'ssh {\n  target "legacy" host="x.test" user="u" keyPath="/k"\n}\n',
		);
		const s = await Settings.init(opts());
		const got = s.get("ssh.hosts" as never) as Record<string, Record<string, unknown>>;
		expect(got.legacy).toMatchObject({ host: "x.test", username: "u", keyPath: "/k" });
	});
});

describe("SSH per-tier precedence (same-name collision)", () => {
	it("project-tier wins over user-tier; warning emitted", async () => {
		await import("@spell/pi-coding-agent/discovery/ssh");
		const { reset: resetCapabilityCache, loadCapability } = await import(
			"@spell/pi-coding-agent/discovery"
		);
		const { sshCapability } = await import("@spell/pi-coding-agent/capability/ssh");

		const s = await Settings.init(opts());
		s.set("ssh.hosts" as never, { shared: { host: "user.host" } } as never, "user");
		s.set("ssh.hosts" as never, { shared: { host: "project.host" } } as never, "project");
		await s.flush();

		_resetSettingsForTest();
		await Settings.init(opts());
		resetCapabilityCache?.();

		const result = await loadCapability(sshCapability.id, { cwd: projectDir });
		const items = result.items as Array<{ name: string; host: string; _source?: { level?: string } }>;
		const shared = items.find(i => i.name === "shared");
		expect(shared?.host).toBe("project.host");
		expect(shared?._source?.level).toBe("project");

		const warnings = result.warnings ?? [];
		expect(warnings.some(w => /shared.*user-tier.*project-tier/.test(w))).toBe(true);
	});
});

describe("GATE 2.6 regressions", () => {
	it("[P2.1] migrator picks up <cwd>/.ssh.json (dot-prefixed)", async () => {
		const legacy = path.join(projectDir, ".ssh.json");
		fs.writeFileSync(legacy, JSON.stringify({ hosts: { dot: { host: "d.test" } } }));

		const s = await Settings.init({ ...opts(), migrate: { yes: true } });
		const got = s.get("ssh.hosts" as never) as Record<string, Record<string, unknown>>;
		expect(got.dot).toMatchObject({ host: "d.test" });
		expect(fs.existsSync(legacy)).toBe(false);
	});

	it("[P2.2] legacy string-form port is coerced to number on migration", async () => {
		const legacy = path.join(agentDir, "ssh.json");
		fs.writeFileSync(
			legacy,
			JSON.stringify({ hosts: { srv: { host: "x.test", port: "2222", compat: "yes" } } }),
		);

		const s = await Settings.init({ ...opts(), migrate: { yes: true } });
		const got = s.get("ssh.hosts" as never) as Record<string, Record<string, unknown>>;
		expect(got.srv.port).toBe(2222);
		expect(got.srv.compat).toBe(true);
	});

	it("[P2.3] legacy `key` alias is rewritten to keyPath on migration", async () => {
		const legacy = path.join(agentDir, "ssh.json");
		fs.writeFileSync(
			legacy,
			JSON.stringify({ hosts: { srv: { host: "x.test", key: "/legacy/id_rsa" } } }),
		);

		const s = await Settings.init({ ...opts(), migrate: { yes: true } });
		const got = s.get("ssh.hosts" as never) as Record<string, Record<string, unknown>>;
		expect(got.srv.keyPath).toBe("/legacy/id_rsa");
	});
});

describe("Migrator: legacy ssh.json → spell.kdl (3 locations)", () => {
	it("translates user-level ssh.json", async () => {
		const legacy = path.join(agentDir, "ssh.json");
		fs.writeFileSync(
			legacy,
			JSON.stringify({
				hosts: {
					user_host: { host: "u.test", username: "u" },
				},
			}),
		);

		const s = await Settings.init({ ...opts(), migrate: { yes: true } });
		const got = s.get("ssh.hosts" as never) as Record<string, Record<string, unknown>>;
		expect(got.user_host).toMatchObject({ host: "u.test", username: "u" });
		expect(fs.existsSync(legacy)).toBe(false);
	});

	it("translates project-level .spell/ssh.json", async () => {
		const legacy = path.join(projectDir, ".spell", "ssh.json");
		fs.mkdirSync(path.dirname(legacy), { recursive: true });
		fs.writeFileSync(legacy, JSON.stringify({ hosts: { p: { host: "p.test" } } }));

		const s = await Settings.init({ ...opts(), migrate: { yes: true } });
		const tiers = s.getPerTier("ssh.hosts" as never);
		expect((tiers.project as Record<string, unknown>).p).toBeDefined();
	});

	it("translates project-root <cwd>/ssh.json", async () => {
		const legacy = path.join(projectDir, "ssh.json");
		fs.writeFileSync(legacy, JSON.stringify({ hosts: { r: { host: "r.test" } } }));

		const s = await Settings.init({ ...opts(), migrate: { yes: true } });
		const tiers = s.getPerTier("ssh.hosts" as never);
		expect((tiers.project as Record<string, unknown>).r).toBeDefined();
		expect(fs.existsSync(legacy)).toBe(false);
	});

	it("merges legacy ssh.json with pre-existing spell.kdl ssh block (manual edits win)", async () => {
		fs.mkdirSync(path.dirname(userKdl), { recursive: true });
		fs.writeFileSync(
			userKdl,
			'ssh {\n  target "shared" hostname="manual.test"\n  target "manual-only" hostname="m.test"\n}\n',
		);
		const legacy = path.join(agentDir, "ssh.json");
		fs.writeFileSync(
			legacy,
			JSON.stringify({
				hosts: {
					shared: { host: "legacy.test" },
					"legacy-only": { host: "l.test" },
				},
			}),
		);

		const s = await Settings.init({ ...opts(), migrate: { yes: true } });
		const got = s.get("ssh.hosts" as never) as Record<string, Record<string, unknown>>;
		expect(got["manual-only"]).toMatchObject({ host: "m.test" });
		expect(got["legacy-only"]).toMatchObject({ host: "l.test" });
		// Manual edit wins on shared name.
		expect(got.shared.host).toBe("manual.test");
	});
});

/**
 * End-to-end: secrets pipeline reads from spell.kdl, no YAML.
 *
 * Covers WAVE 2 of PLAN-311:
 *   - Settings.get("secrets") returns the array shape consumers expect
 *   - loadSecrets() returns validated entries sourced from spell.kdl
 *   - Migrator translates legacy secrets.yml into the secrets block
 *   - SecretObfuscator works end-to-end with KDL-sourced secrets
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _resetSettingsForTest, Settings } from "@spell/pi-coding-agent/config/settings";
import { loadSecrets, SecretObfuscator } from "@spell/pi-coding-agent/secrets";
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
	tmp = path.join(os.tmpdir(), "secrets-kdl", Snowflake.next());
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

describe("secrets ← spell.kdl", () => {
	it("Settings.get('secrets') returns empty array when none configured", async () => {
		const s = await Settings.init(opts());
		expect(s.get("secrets")).toEqual([]);
	});

	it("Settings round-trip preserves all SecretEntry fields", async () => {
		const s = await Settings.init(opts());
		const original = [
			{ type: "plain", content: "sk-abc-1234567890" },
			{
				type: "regex",
				content: "AKIA[0-9A-Z]{16}",
				mode: "replace",
				replacement: "<aws-key>",
				flags: "i",
			},
		];
		s.set("secrets", original as never);
		await s.flush();

		_resetSettingsForTest();
		const s2 = await Settings.init(opts());
		const got = s2.get("secrets") as Array<Record<string, unknown>>;
		expect(got).toHaveLength(2);
		expect(got[0]).toMatchObject({ type: "plain", content: "sk-abc-1234567890" });
		expect(got[1]).toMatchObject({
			type: "regex",
			content: "AKIA[0-9A-Z]{16}",
			mode: "replace",
			replacement: "<aws-key>",
			flags: "i",
		});
	});

	it("loadSecrets() returns validated entries sourced from Settings", async () => {
		const s = await Settings.init(opts());
		s.set(
			"secrets",
			[
				{ type: "plain", content: "sk-validated" },
				// Invalid entry — should be skipped, not throw.
				{ type: "unknown-type", content: "x" },
				// Invalid regex — should be skipped.
				{ type: "regex", content: "[unclosed" },
			] as never,
		);
		await s.flush();

		const entries = await loadSecrets(projectDir, agentDir);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ type: "plain", content: "sk-validated", mode: "obfuscate" });
	});

	it("SecretObfuscator works with secrets sourced from spell.kdl", async () => {
		const s = await Settings.init(opts());
		s.set(
			"secrets",
			[{ type: "plain", content: "hunter2-the-secret-passphrase" }] as never,
		);
		await s.flush();

		const entries = await loadSecrets(projectDir, agentDir);
		const obfuscator = new SecretObfuscator(entries);

		const obfuscated = obfuscator.obfuscate("Please log in with hunter2-the-secret-passphrase and proceed");
		expect(obfuscated).not.toContain("hunter2-the-secret-passphrase");
		expect(obfuscator.deobfuscate(obfuscated)).toContain("hunter2-the-secret-passphrase");
	});
});

describe("GATE 2a regressions", () => {
	it("[P1] user-tier + project-tier secrets BOTH apply (no array replace)", async () => {
		const s = await Settings.init(opts());
		s.set("secrets", [{ type: "plain", content: "USER_SECRET" }] as never, "user");
		s.set("secrets", [{ type: "plain", content: "PROJECT_SECRET" }] as never, "project");
		await s.flush();

		const entries = await loadSecrets(projectDir, agentDir);
		const contents = entries.map(e => e.content);
		expect(contents).toContain("USER_SECRET");
		expect(contents).toContain("PROJECT_SECRET");
	});

	it("[P1] cross-tier dedupes by content (no double-obfuscation)", async () => {
		const s = await Settings.init(opts());
		s.set("secrets", [{ type: "plain", content: "SHARED" }] as never, "user");
		s.set("secrets", [{ type: "plain", content: "SHARED" }] as never, "project");
		await s.flush();

		const entries = await loadSecrets(projectDir, agentDir);
		expect(entries.filter(e => e.content === "SHARED")).toHaveLength(1);
	});

	it("[P1] all four tiers contribute when set (user + local + project + session)", async () => {
		const s = await Settings.init(opts());
		s.set("secrets", [{ type: "plain", content: "USR" }] as never, "user");
		s.set("secrets", [{ type: "plain", content: "PRJ" }] as never, "project");
		s.set("secrets", [{ type: "plain", content: "LCL" }] as never, "local");
		s.set("secrets", [{ type: "plain", content: "SES" }] as never, "session");
		await s.flush();

		const entries = await loadSecrets(projectDir, agentDir);
		const contents = entries.map(e => e.content);
		expect(contents).toEqual(expect.arrayContaining(["USR", "PRJ", "LCL", "SES"]));
	});

	it("[P2] migrator unions legacy YAML with pre-existing spell.kdl secrets", async () => {
		// Pre-existing secrets block in user spell.kdl (manual edit).
		fs.mkdirSync(path.dirname(userKdl), { recursive: true });
		fs.writeFileSync(
			userKdl,
			'secrets {\n  secret type=plain content="MANUAL_EDIT_SECRET"\n}\n',
		);

		// Legacy YAML with a different secret.
		const legacy = path.join(agentDir, "secrets.yml");
		fs.writeFileSync(legacy, "- type: plain\n  content: LEGACY_SECRET\n");

		const s = await Settings.init({ ...opts(), migrate: { yes: true } });
		const got = (s.get("secrets") as Array<Record<string, unknown>>).map(e => e.content);
		expect(got).toContain("MANUAL_EDIT_SECRET");
		expect(got).toContain("LEGACY_SECRET");
	});

	it("[P3a] malformed YAML (top-level scalar) does NOT poison settings.secrets", async () => {
		const legacy = path.join(agentDir, "secrets.yml");
		fs.writeFileSync(legacy, '"just-a-scalar"\n');

		const s = await Settings.init({ ...opts(), migrate: { yes: true } });
		const got = s.get("secrets");
		// Settings must remain an array (default), not become the scalar.
		expect(Array.isArray(got)).toBe(true);
	});

	it("[P3b] readSecrets rejects unknown type (does not silently coerce to plain)", async () => {
		fs.mkdirSync(path.dirname(userKdl), { recursive: true });
		fs.writeFileSync(
			userKdl,
			'secrets {\n  secret type=regexp content="AKIA[0-9A-Z]{16}"\n  secret type=plain content="GOOD"\n}\n',
		);
		const s = await Settings.init(opts());
		const got = (s.get("secrets") as Array<Record<string, unknown>>).map(e => e.content);
		// "regexp" entry rejected (not coerced to plain); good entry preserved.
		expect(got).not.toContain("AKIA[0-9A-Z]{16}");
		expect(got).toContain("GOOD");
	});
});

describe("Migrator: legacy secrets.yml → spell.kdl", () => {
	it("translates user-level secrets.yml into the secrets block", async () => {
		const legacy = path.join(agentDir, "secrets.yml");
		fs.writeFileSync(
			legacy,
			[
				"- type: plain",
				"  content: sk-migrated-1",
				"- type: regex",
				"  content: 'AKIA[0-9A-Z]{16}'",
				"  mode: replace",
				"  replacement: <x>",
				"  flags: i",
				"",
			].join("\n"),
		);

		const s = await Settings.init({ ...opts(), migrate: { yes: true } });
		const got = s.get("secrets") as Array<Record<string, unknown>>;
		expect(got).toHaveLength(2);
		expect(got[0]).toMatchObject({ type: "plain", content: "sk-migrated-1" });
		expect(got[1]).toMatchObject({
			type: "regex",
			content: "AKIA[0-9A-Z]{16}",
			mode: "replace",
			replacement: "<x>",
			flags: "i",
		});
		// Source moved to .bak.
		expect(fs.existsSync(legacy)).toBe(false);
		// User KDL exists and contains the secrets block.
		const kdlContent = fs.readFileSync(userKdl, "utf8");
		expect(kdlContent).toMatch(/secrets[\s\S]*secret/);
	});

	it("translates project-level secrets.yml into project spell.kdl", async () => {
		const legacy = path.join(projectDir, ".spell", "secrets.yml");
		fs.mkdirSync(path.dirname(legacy), { recursive: true });
		fs.writeFileSync(legacy, "- type: plain\n  content: project-only\n");

		const s = await Settings.init({ ...opts(), migrate: { yes: true } });
		const got = s.get("secrets") as Array<Record<string, unknown>>;
		expect(got).toHaveLength(1);
		expect(got[0]).toMatchObject({ type: "plain", content: "project-only" });

		// Project KDL, not user KDL.
		expect(fs.existsSync(projectKdl)).toBe(true);
		expect(fs.existsSync(userKdl)).toBe(false);
	});

	it("idempotent: re-running after migration is a no-op (no reprompt)", async () => {
		const legacy = path.join(agentDir, "secrets.yml");
		fs.writeFileSync(legacy, "- type: plain\n  content: hunter\n");
		await Settings.init({ ...opts(), migrate: { yes: true } });

		_resetSettingsForTest();
		// Second run: legacy is .bak'd. Detector skips. No errors.
		const s2 = await Settings.init({ ...opts(), migrate: { yes: true } });
		const got = s2.get("secrets") as Array<Record<string, unknown>>;
		expect(got).toHaveLength(1);
		expect(got[0]).toMatchObject({ type: "plain", content: "hunter" });
	});
});

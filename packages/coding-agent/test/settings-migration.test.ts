/**
 * Integration: Settings.init() runs the one-shot migrator before loading.
 *
 * Distinguishes from src/migration/test/index.test.ts (which tests the
 * migrator in isolation): these tests exercise the *wiring* — that legacy
 * files land in KDL and are visible through `settings.get()` on the same
 * launch.
 *
 * After WAVE 8 cleanup (rm -rf src/migration/), this file is deleted too.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _resetSettingsForTest, Settings } from "@spell/pi-coding-agent/config/settings";
import { Snowflake } from "@spell/pi-utils";

let tmpRoot: string;
let userAgentDir: string;
let projectDir: string;
let projectAgentDir: string;
let userKdl: string;
let projectKdl: string;
let localKdl: string;

function initOptions() {
	return {
		cwd: projectDir,
		agentDir: userAgentDir,
		userKdlPath: userKdl,
		projectKdlPath: projectKdl,
		localKdlPath: localKdl,
	};
}

beforeEach(() => {
	_resetSettingsForTest();
	tmpRoot = path.join(os.tmpdir(), "settings-migration", Snowflake.next());
	userAgentDir = path.join(tmpRoot, "home", ".spell", "agent");
	projectDir = path.join(tmpRoot, "project");
	projectAgentDir = path.join(projectDir, ".spell");
	fs.mkdirSync(userAgentDir, { recursive: true });
	fs.mkdirSync(projectAgentDir, { recursive: true });
	fs.mkdirSync(path.join(projectAgentDir, "agent"), { recursive: true });
	userKdl = path.join(tmpRoot, "user-config", "spell.kdl");
	projectKdl = path.join(projectDir, "spell.kdl");
	localKdl = path.join(projectDir, ".local", "spell.kdl");
});

afterEach(() => {
	if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true });
});

describe("Settings.init: legacy migration wiring", () => {
	it("no legacy files → KDL files not created, no migration noise", async () => {
		const s = await Settings.init(initOptions());
		// Default thinking level should be the schema default, not a translated value.
		expect(s.get("defaultThinkingLevel")).toBeDefined();
		expect(fs.existsSync(userKdl)).toBe(false);
		expect(fs.existsSync(projectKdl)).toBe(false);
	});

	it("legacy YAML present but no TTY → preserved, NOT auto-migrated", async () => {
		// Settings.init in tests runs with isTTY=undefined → dialog returns "no".
		// Source must remain untouched so the user can opt-in later.
		const legacy = path.join(userAgentDir, "config.yml");
		fs.writeFileSync(legacy, "defaultThinkingLevel: high\n");

		await Settings.init(initOptions());

		expect(fs.existsSync(legacy)).toBe(true);
		expect(fs.existsSync(userKdl)).toBe(false);
	});

	it("legacy JSON present but no TTY → preserved, NOT auto-migrated", async () => {
		const legacy = path.join(projectAgentDir, "settings.json");
		fs.writeFileSync(legacy, JSON.stringify({ theme: { dark: "anthracite" } }));

		await Settings.init(initOptions());

		expect(fs.existsSync(legacy)).toBe(true);
		expect(fs.existsSync(projectKdl)).toBe(false);
	});

	it("legacy + .bak sibling → migrator skips, no prompt, settings load from KDL only", async () => {
		// Simulate a previous successful migration.
		const legacy = path.join(userAgentDir, "config.yml");
		fs.writeFileSync(legacy, "defaultThinkingLevel: high\n");
		fs.writeFileSync(`${legacy}.migrated-2026-01-01.bak`, "old");

		// Pre-existing KDL at dest with the translated value.
		fs.mkdirSync(path.dirname(userKdl), { recursive: true });
		fs.writeFileSync(userKdl, 'model {\n  thinking "high"\n}\n');

		const s = await Settings.init(initOptions());
		expect(s.get("defaultThinkingLevel")).toBe("high");
		// Legacy file untouched (no re-migration).
		expect(fs.existsSync(legacy)).toBe(true);
	});
});

describe("Migrator driven via Settings.init({ migrate: { yes: true } })", () => {
	it("translates legacy YAML and exposes the value on the same launch", async () => {
		fs.writeFileSync(path.join(userAgentDir, "config.yml"), "defaultThinkingLevel: high\n");

		const s = await Settings.init({ ...initOptions(), migrate: { yes: true } });
		expect(s.get("defaultThinkingLevel")).toBe("high");
		expect(fs.existsSync(userKdl)).toBe(true);
	});

	it("translates legacy ~/.spell/spell.kdl into the new user destination", async () => {
		const legacyKdl = path.join(path.dirname(userAgentDir), "spell.kdl");
		fs.writeFileSync(legacyKdl, 'model {\n  thinking "medium"\n}\n');

		const s = await Settings.init({ ...initOptions(), migrate: { yes: true } });
		expect(s.get("defaultThinkingLevel")).toBe("medium");
		expect(fs.existsSync(userKdl)).toBe(true);
		expect(fs.existsSync(legacyKdl)).toBe(false);
	});
});

describe("Idempotency at the Settings.init layer", () => {
	it("two Settings.init cycles after migration yield identical state", async () => {
		fs.writeFileSync(path.join(userAgentDir, "config.yml"), "defaultThinkingLevel: high\n");

		const s1 = await Settings.init({ ...initOptions(), migrate: { yes: true } });
		const v1 = s1.get("defaultThinkingLevel");

		_resetSettingsForTest();
		const s2 = await Settings.init(initOptions());
		const v2 = s2.get("defaultThinkingLevel");

		expect(v1).toBe(v2);
		expect(v1).toBe("high");
	});
});

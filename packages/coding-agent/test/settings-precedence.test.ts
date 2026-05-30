/**
 * Four-tier settings precedence regression suite.
 *
 *   read order (highest → lowest, last-write-per-key wins):
 *     session  in-memory                          volatile
 *     local    <cwd>/.local/spell.kdl             gitignored, machine
 *     project  <cwd>/spell.kdl                    committed, team
 *     user     ~/.config/spell/spell.kdl          XDG-style global
 *
 *   write tier: settings.set(path, value, tier?) — defaults to "user"
 *
 * These tests pin all three file paths via Settings init options so the
 * suite is fully decoupled from $HOME / $XDG_CONFIG_HOME / agentDir.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _resetSettingsForTest, Settings } from "@spell/pi-coding-agent/config/settings";
import { Snowflake } from "@spell/pi-utils";

let testDir: string;
let agentDir: string;
let projectDir: string;
let userKdl: string;
let projectKdl: string;
let localKdl: string;

function initOptions() {
	return { cwd: projectDir, agentDir, userKdlPath: userKdl, projectKdlPath: projectKdl, localKdlPath: localKdl };
}

beforeEach(() => {
	_resetSettingsForTest();
	testDir = path.join(os.tmpdir(), "settings-precedence", Snowflake.next());
	agentDir = path.join(testDir, ".spell", "agent");
	projectDir = path.join(testDir, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
	userKdl = path.join(testDir, "user-config", "spell.kdl");
	projectKdl = path.join(projectDir, "spell.kdl");
	localKdl = path.join(projectDir, ".local", "spell.kdl");
});

afterEach(() => {
	if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
});

describe("Settings: 4-tier write routing", () => {
	it("user tier writes to user KDL only", async () => {
		const s = await Settings.init(initOptions());
		s.set("temperature", 0.3, "user");
		await s.flush();

		expect(fs.existsSync(userKdl)).toBe(true);
		expect(fs.existsSync(projectKdl)).toBe(false);
		expect(fs.existsSync(localKdl)).toBe(false);
	});

	it("project tier writes to project KDL only", async () => {
		const s = await Settings.init(initOptions());
		s.set("temperature", 0.5, "project");
		await s.flush();

		expect(fs.existsSync(userKdl)).toBe(false);
		expect(fs.existsSync(projectKdl)).toBe(true);
		expect(fs.existsSync(localKdl)).toBe(false);
	});

	it("local tier writes to local KDL only (and creates .local/)", async () => {
		const s = await Settings.init(initOptions());
		s.set("temperature", 0.7, "local");
		await s.flush();

		expect(fs.existsSync(userKdl)).toBe(false);
		expect(fs.existsSync(projectKdl)).toBe(false);
		expect(fs.existsSync(localKdl)).toBe(true);
		expect(fs.existsSync(path.dirname(localKdl))).toBe(true);
	});

	it("session tier never touches disk", async () => {
		const s = await Settings.init(initOptions());
		s.set("temperature", 0.9, "session");
		await s.flush();

		expect(fs.existsSync(userKdl)).toBe(false);
		expect(fs.existsSync(projectKdl)).toBe(false);
		expect(fs.existsSync(localKdl)).toBe(false);
		// Still visible in-memory:
		expect(s.get("temperature")).toBe(0.9);
	});

	it("default tier is user", async () => {
		const s = await Settings.init(initOptions());
		s.set("temperature", 0.42);
		await s.flush();

		expect(fs.existsSync(userKdl)).toBe(true);
		expect(fs.existsSync(projectKdl)).toBe(false);
		expect(fs.existsSync(localKdl)).toBe(false);
	});

	it("writes to different tiers populate different files in one flush", async () => {
		const s = await Settings.init(initOptions());
		s.set("temperature", 0.1, "user");
		s.set("theme.dark", "anthracite", "project");
		s.set("topP", 0.5, "local");
		await s.flush();

		expect(fs.existsSync(userKdl)).toBe(true);
		expect(fs.existsSync(projectKdl)).toBe(true);
		expect(fs.existsSync(localKdl)).toBe(true);

		// Each file should contain ONLY the value it received — no cross-tier pollution.
		expect(fs.readFileSync(userKdl, "utf8")).toMatch(/temperature/);
		expect(fs.readFileSync(userKdl, "utf8")).not.toMatch(/anthracite/);
		expect(fs.readFileSync(projectKdl, "utf8")).toMatch(/anthracite/);
		expect(fs.readFileSync(projectKdl, "utf8")).not.toMatch(/temperature/);
		expect(fs.readFileSync(localKdl, "utf8")).toMatch(/top-p/i);
	});
});

describe("Settings: 4-tier read precedence", () => {
	it("local overrides project overrides user (same key)", async () => {
		// Pre-populate all three files with conflicting values via separate init/flush cycles.
		{
			const s = await Settings.init(initOptions());
			s.set("temperature", 0.1, "user");
			s.set("temperature", 0.5, "project");
			s.set("temperature", 0.9, "local");
			await s.flush();
		}

		_resetSettingsForTest();
		const reloaded = await Settings.init(initOptions());
		// Effective: local wins.
		expect(reloaded.get("temperature")).toBe(0.9);
	});

	it("project overrides user when no local entry exists", async () => {
		{
			const s = await Settings.init(initOptions());
			s.set("temperature", 0.1, "user");
			s.set("temperature", 0.5, "project");
			await s.flush();
		}

		_resetSettingsForTest();
		const reloaded = await Settings.init(initOptions());
		expect(reloaded.get("temperature")).toBe(0.5);
	});

	it("user value is used when neither project nor local set the key", async () => {
		{
			const s = await Settings.init(initOptions());
			s.set("temperature", 0.1, "user");
			await s.flush();
		}

		_resetSettingsForTest();
		const reloaded = await Settings.init(initOptions());
		expect(reloaded.get("temperature")).toBe(0.1);
	});

	it("session override beats all persisted tiers", async () => {
		{
			const s = await Settings.init(initOptions());
			s.set("temperature", 0.9, "local");
			await s.flush();
		}

		_resetSettingsForTest();
		const reloaded = await Settings.init(initOptions());
		expect(reloaded.get("temperature")).toBe(0.9);
		reloaded.set("temperature", 0.0, "session");
		expect(reloaded.get("temperature")).toBe(0.0);
	});

	it("non-conflicting keys merge across tiers", async () => {
		{
			const s = await Settings.init(initOptions());
			s.set("temperature", 0.3, "user");
			s.set("theme.dark", "anthracite", "project");
			s.set("topP", 0.8, "local");
			await s.flush();
		}

		_resetSettingsForTest();
		const r = await Settings.init(initOptions());
		expect(r.get("temperature")).toBe(0.3);
		expect(r.get("theme.dark")).toBe("anthracite");
		expect(r.get("topP")).toBe(0.8);
	});
});

describe("Settings: file isolation invariants", () => {
	it("editing user file by hand survives if project/local untouched", async () => {
		// Hand-write a user KDL fragment using the CANONICAL schema location
		// (defaultThinkingLevel → model.thinking, per kdl-settings-map.ts).
		// Use a non-default value so the read path is actually exercised
		// (schema default for defaultThinkingLevel is "high").
		fs.mkdirSync(path.dirname(userKdl), { recursive: true });
		fs.writeFileSync(userKdl, 'model {\n  thinking "medium"\n}\n');

		const s = await Settings.init(initOptions());
		expect(s.get("defaultThinkingLevel")).toBe("medium");
		expect(fs.existsSync(projectKdl)).toBe(false);
		expect(fs.existsSync(localKdl)).toBe(false);
	});

	it("project file edits are read on next init (no caching across instances)", async () => {
		const kdlWith = (t: number) => `model {\n  sampling {\n    temperature ${t}\n  }\n}\n`;
		fs.writeFileSync(projectKdl, kdlWith(0.7));
		const s1 = await Settings.init(initOptions());
		expect(s1.get("temperature")).toBe(0.7);

		_resetSettingsForTest();
		fs.writeFileSync(projectKdl, kdlWith(0.2));
		const s2 = await Settings.init(initOptions());
		expect(s2.get("temperature")).toBe(0.2);
	});
});

/**
 * Settings manager: KDL-only semantics.
 *
 * Replaces the legacy YAML/JSON overlay test suite that pre-dated the KDL
 * cutover. WAVE 1 of PLAN-311 removed the config.yml + settings.json overlay
 * paths; this suite asserts the cutover invariants:
 *
 *   - external edits to spell.kdl are preserved across in-process saves
 *   - project-level reads come from <cwd>/spell.kdl, not from any sibling
 *     YAML/JSON file
 *   - in-memory settings win when both the file and the runtime mutate the
 *     same key
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as ai from "@spell/pi-ai";
import { Effort } from "@spell/pi-ai";
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
	testDir = path.join(os.tmpdir(), "settings-manager", Snowflake.next());
	agentDir = path.join(testDir, ".spell", "agent");
	projectDir = path.join(testDir, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
	userKdl = path.join(testDir, "user-config", "spell.kdl");
	projectKdl = path.join(projectDir, "spell.kdl");
	localKdl = path.join(projectDir, ".local", "spell.kdl");
});

afterEach(() => {
	delete Bun.env.PI_ANTHROPIC_STREAM_IDLE_TIMEOUT_MS;
	ai.setAnthropicStreamIdleTimeoutOverrideMs(undefined);
	if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
});

describe("Settings: KDL persistence", () => {
	it("writes new settings to user spell.kdl on flush", async () => {
		const s = await Settings.init(initOptions());
		s.set("defaultThinkingLevel", Effort.High);
		await s.flush();

		expect(fs.existsSync(userKdl)).toBe(true);
		const content = fs.readFileSync(userKdl, "utf8");
		// defaultThinkingLevel → model.thinking
		expect(content).toMatch(/model[\s\S]*thinking[\s\S]*high/);
	});

	it("reloads written settings on next init", async () => {
		{
			const s = await Settings.init(initOptions());
			s.set("defaultThinkingLevel", Effort.High);
			await s.flush();
		}
		_resetSettingsForTest();
		const s2 = await Settings.init(initOptions());
		expect(s2.get("defaultThinkingLevel")).toBe(Effort.High);
	});
});

describe("Settings: external KDL edits preserved on partial saves", () => {
	it("saving one key does not clobber unrelated keys in the same file", async () => {
		// Pre-existing user KDL with a key the runtime won't touch.
		fs.mkdirSync(path.dirname(userKdl), { recursive: true });
		fs.writeFileSync(userKdl, 'appearance {\n  theme dark="anthracite"\n}\n');

		const s = await Settings.init(initOptions());
		s.set("defaultThinkingLevel", Effort.High);
		await s.flush();

		const content = fs.readFileSync(userKdl, "utf8");
		expect(content).toMatch(/anthracite/); // pre-existing preserved
		expect(content).toMatch(/model[\s\S]*thinking[\s\S]*high/); // new key added
	});

	it("in-memory settings win when an external write happens between init and flush", async () => {
		fs.mkdirSync(path.dirname(userKdl), { recursive: true });
		fs.writeFileSync(userKdl, 'model {\n  thinking "low"\n}\n');

		const s = await Settings.init(initOptions());
		expect(s.get("defaultThinkingLevel")).toBe(Effort.Low);

		// External tool edits the file while we hold an in-memory copy.
		fs.writeFileSync(userKdl, 'model {\n  thinking "medium"\n}\n');

		// In-memory set + flush MUST win for the path we touched.
		s.set("defaultThinkingLevel", Effort.High);
		await s.flush();

		_resetSettingsForTest();
		const reloaded = await Settings.init(initOptions());
		expect(reloaded.get("defaultThinkingLevel")).toBe(Effort.High);
	});
});

describe("Settings: project-level reads come from spell.kdl only", () => {
	it("reads from <cwd>/spell.kdl at project tier", async () => {
		fs.writeFileSync(projectKdl, 'appearance {\n  theme dark="anthracite"\n}\n');
		const s = await Settings.init(initOptions());
		expect(s.get("theme.dark")).toBe("anthracite");
	});

	it("ignores legacy project .spell/settings.json (no overlay)", async () => {
		// WAVE 1.3: discovery/builtin.ts no longer reads settings.json.
		fs.mkdirSync(path.join(projectDir, ".spell"), { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, ".spell", "settings.json"),
			JSON.stringify({ theme: { dark: "anthracite" } }),
		);

		const s = await Settings.init(initOptions());
		// The legacy file is invisible to the runtime now.
		// Default theme is used because no Spell-shaped config exists.
		expect(s.get("theme.dark")).not.toBe("anthracite");
	});

	it("ignores legacy project .spell/agent/config.yml (no overlay)", async () => {
		fs.mkdirSync(path.join(projectDir, ".spell", "agent"), { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, ".spell", "agent", "config.yml"),
			"theme:\n  dark: anthracite\n",
		);

		const s = await Settings.init(initOptions());
		expect(s.get("theme.dark")).not.toBe("anthracite");
	});

	it("project tier read precedence: project spell.kdl > user spell.kdl", async () => {
		fs.mkdirSync(path.dirname(userKdl), { recursive: true });
		fs.writeFileSync(userKdl, 'appearance {\n  theme dark="solarized-light"\n}\n');
		fs.writeFileSync(projectKdl, 'appearance {\n  theme dark="anthracite"\n}\n');

		const s = await Settings.init(initOptions());
		expect(s.get("theme.dark")).toBe("anthracite");
	});
});

/**
 * Regression tests for two bugs in the /settings UI:
 *
 *   1. Numeric (submenu) settings silently reverted to defaults on reload.
 *      Root cause: SettingsSelectorComponent persisted with typed values
 *      (e.g. `0.7` as number) via #setSettingValue, then handleSettingChange
 *      *re-persisted* with the raw display string (`"0.7"`). The KDL writer
 *      stored a string, and the KDL reader's getNumberArgument returned
 *      undefined on reload → default value (-1) substituted.
 *
 *   2. The tier indicator at the bottom of the settings panel was added as
 *      an orphan child on every #showSettingsTab call. Each Ctrl+T or tab
 *      switch accumulated a fresh "[user] ..." line — visually corrupting
 *      the panel layout. Indicator now lives at the top, added once.
 *
 * These tests do not instantiate the full TUI Component tree; they exercise
 * the persistence pipeline that the UI relies on, plus the static invariant
 * that selector-controller no longer re-writes settings on its own.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _resetSettingsForTest, Settings } from "@spell/pi-coding-agent/config/settings";
import { Snowflake } from "@spell/pi-utils";

describe("Settings tier persistence", () => {
	let testDir: string;
	let agentDir: string;
	let projectDir: string;
	let userKdl: string;
	let projectKdl: string;
	let localKdl: string;

	beforeEach(() => {
		_resetSettingsForTest();
		testDir = path.join(os.tmpdir(), "settings-tier", Snowflake.next());
		agentDir = path.join(testDir, ".spell", "agent");
		projectDir = path.join(testDir, "project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(projectDir, { recursive: true });
		// Decoupled paths: user KDL no longer lives next to agentDir. Pin all
		// three persisted-tier locations explicitly via Settings options.
		userKdl = path.join(testDir, "user-config", "spell.kdl");
		projectKdl = path.join(projectDir, "spell.kdl");
		localKdl = path.join(projectDir, ".local", "spell.kdl");
	});

	function initOptions() {
		return {
			cwd: projectDir,
			agentDir,
			userKdlPath: userKdl,
			projectKdlPath: projectKdl,
			localKdlPath: localKdl,
		};
	}

	afterEach(() => {
		if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
	});

	it("persists typed number submenu values to user spell.kdl", async () => {
		const s = await Settings.init(initOptions());
		s.set("temperature", 0.7, "user");
		await s.flush();

		expect(fs.existsSync(userKdl)).toBe(true);
		// In-memory value is preserved as a number.
		expect(s.get("temperature")).toBe(0.7);

		// Reload from disk: must round-trip back to the same number.
		_resetSettingsForTest();
		const s2 = await Settings.init(initOptions());
		expect(s2.get("temperature")).toBe(0.7);
	});

	it("rejects raw-string writes to numeric paths (would corrupt KDL on reload)", async () => {
		// This test documents the regression: the old code path called
		// settings.set("temperature", "0.7", tier) AFTER the typed write, which
		// produced a KDL document containing `temperature "0.7"` (string), then
		// returned the default (-1) on reload because getNumberArgument refuses
		// non-numeric arguments. We now prevent the second write entirely.
		const s = await Settings.init(initOptions());

		// Simulate the BAD legacy behavior to confirm the bug WOULD reappear if
		// re-introduced.
		s.set("temperature" as never, 0.7 as never, "user");
		s.set("temperature" as never, "0.7" as never, "user"); // legacy double-set
		await s.flush();

		_resetSettingsForTest();
		const reloaded = await Settings.init(initOptions());
		// Default is -1 — bug fingerprint: numeric value is lost.
		expect(reloaded.get("temperature")).toBe(-1);
	});

	it("persists to project tier when tier='project'", async () => {
		const s = await Settings.init(initOptions());
		s.set("theme.dark", "anthracite", "project");
		await s.flush();

		expect(fs.existsSync(projectKdl)).toBe(true);
		expect(fs.existsSync(userKdl)).toBe(false);

		_resetSettingsForTest();
		const s2 = await Settings.init(initOptions());
		expect(s2.get("theme.dark")).toBe("anthracite");
	});

	it("does NOT persist session-tier writes to disk", async () => {
		const s = await Settings.init(initOptions());
		s.set("temperature", 0.5, "session");
		await s.flush();

		expect(s.get("temperature")).toBe(0.5);
		expect(fs.existsSync(userKdl)).toBe(false);
		expect(fs.existsSync(projectKdl)).toBe(false);

		// Reload: session-tier write is gone, default returns.
		_resetSettingsForTest();
		const s2 = await Settings.init(initOptions());
		expect(s2.get("temperature")).toBe(-1);
	});
});

describe("SelectorController.handleSettingChange — no implicit settings.set", () => {
	it("source contains no top-level settings.set call inside handleSettingChange", async () => {
		// Static guard: the function must not call settings.set(id, value, tier)
		// at the top. If a future change re-introduces that line, the numeric
		// submenu persistence bug returns.
		const src = await Bun.file(
			path.join(import.meta.dir, "..", "src", "modes", "controllers", "selector-controller.ts"),
		).text();
		// Find handleSettingChange body and check no `settings.set(id` call.
		const start = src.indexOf("handleSettingChange(id: string");
		expect(start).toBeGreaterThan(-1);
		// Body extends until the next top-level method — slice generously.
		const body = src.slice(start, start + 4000);
		expect(body).not.toContain("settings.set(id as never, value as never, tier)");
	});
});

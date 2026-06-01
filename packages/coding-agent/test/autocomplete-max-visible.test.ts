import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _resetSettingsForTest, Settings } from "@spell/pi-coding-agent/config/settings";
import { getDefault } from "@spell/pi-coding-agent/config/settings-schema";
import { SelectorController } from "@spell/pi-coding-agent/modes/controllers/selector-controller";
import { Snowflake } from "@spell/pi-utils";

describe("autocompleteMaxVisible setting", () => {
	let testDir: string;
	let agentDir: string;
	let projectDir: string;
	let userKdl: string;
	let projectKdl: string;
	let localKdl: string;

	function initOptions() {
		return {
			cwd: projectDir,
			agentDir,
			userKdlPath: userKdl,
			projectKdlPath: projectKdl,
			localKdlPath: localKdl,
		};
	}

	beforeEach(() => {
		_resetSettingsForTest();
		testDir = path.join(os.tmpdir(), "autocomplete-settings", Snowflake.next());
		agentDir = path.join(testDir, ".spell", "agent");
		projectDir = path.join(testDir, "project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(projectDir, { recursive: true });
		userKdl = path.join(testDir, "user-config", "spell.kdl");
		projectKdl = path.join(projectDir, "spell.kdl");
		localKdl = path.join(projectDir, ".local", "spell.kdl");
	});

	afterEach(() => {
		_resetSettingsForTest();
		if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
	});

	it("has default value of 5", () => {
		expect(getDefault("autocompleteMaxVisible")).toBe(5);
	});

	it("returns default when not configured", async () => {
		const settings = await Settings.init(initOptions());
		expect(settings.get("autocompleteMaxVisible")).toBe(5);
	});

	it("persists and reads back a configured value via KDL", async () => {
		const settings = await Settings.init(initOptions());
		settings.set("autocompleteMaxVisible", 10);
		await settings.flush();

		_resetSettingsForTest();
		const settings2 = await Settings.init(initOptions());
		expect(settings2.get("autocompleteMaxVisible")).toBe(10);
	});

	it("reads from a hand-written user spell.kdl", async () => {
		// Pre-populate user KDL by hand to test the read path.
		fs.mkdirSync(path.dirname(userKdl), { recursive: true });
		fs.writeFileSync(userKdl, "interaction {\n  autocomplete-max-visible 15\n}\n");
		const settings = await Settings.init(initOptions());
		expect(settings.get("autocompleteMaxVisible")).toBe(15);
	});

	it("coerces submenu string values for live editor updates", () => {
		const setAutocompleteMaxVisible = vi.fn();
		const controller = new SelectorController({
			editor: { setAutocompleteMaxVisible },
		} as unknown as ConstructorParameters<typeof SelectorController>[0]);

		controller.handleSettingChange("autocompleteMaxVisible", "10", "user");

		expect(setAutocompleteMaxVisible).toHaveBeenCalledWith(10);
	});

	it("works with isolated instances", () => {
		const settings = Settings.isolated({ autocompleteMaxVisible: 12 });
		expect(settings.get("autocompleteMaxVisible")).toBe(12);
	});
});

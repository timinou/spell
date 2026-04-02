import { describe, expect, test } from "bun:test";
import { Settings } from "../../src/config/settings";
import { SETTINGS_SCHEMA } from "../../src/config/settings-schema";

describe("task auto-roster settings", () => {
	test("task.autoRoster defaults to true", () => {
		expect(SETTINGS_SCHEMA["task.autoRoster"]).toMatchObject({
			type: "boolean",
			default: true,
		});
		expect(Settings.isolated().get("task.autoRoster")).toBe(true);
	});

	test("Settings.isolated respects task.autoRoster=false", () => {
		const settings = Settings.isolated({ "task.autoRoster": false });
		expect(settings.get("task.autoRoster")).toBe(false);
	});

	test("todo.enabled takes precedence over task.autoRoster in prompt context", () => {
		const settings = Settings.isolated({
			"todo.enabled": false,
			"task.autoRoster": true,
		});

		const autoRosterEnabled = settings.get("todo.enabled") && settings.get("task.autoRoster");
		expect(autoRosterEnabled).toBe(false);
	});

	test("todo.eager and task.autoRoster can both be enabled", () => {
		const settings = Settings.isolated({
			"todo.eager": true,
			"task.autoRoster": true,
		});

		expect(settings.get("todo.eager")).toBe(true);
		expect(settings.get("task.autoRoster")).toBe(true);
	});
});

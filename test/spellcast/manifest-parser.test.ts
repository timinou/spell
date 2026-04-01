import { describe, expect, test } from "bun:test";
import { parseSpellcastManifest } from "@oh-my-pi/pi-coding-agent/spellcast/manifest";

describe("parseSpellcastManifest", () => {
	test("parses a valid manifest", () => {
		const parsed = parseSpellcastManifest(`
name: weather-widget
description: Weather dashboard
entry: ./WeatherWidget.qml
files:
  - ./WeatherWidget.qml
  - ./weather-data.json
visibility: public
tools:
  - read
  - grep
auto_sync: true
`);

		expect(parsed).toEqual({
			name: "weather-widget",
			description: "Weather dashboard",
			entry: "./WeatherWidget.qml",
			files: ["./WeatherWidget.qml", "./weather-data.json"],
			visibility: "public",
			tools: ["read", "grep"],
			auto_sync: true,
		});
	});

	test("applies defaults for optional fields", () => {
		const parsed = parseSpellcastManifest(`
name: hello-world
entry: app/Main.qml
files:
  - app/Main.qml
`);

		expect(parsed.visibility).toBe("unlisted");
		expect(parsed.tools).toEqual(["read"]);
		expect(parsed.auto_sync).toBe(false);
	});

	test("throws when entry is missing", () => {
		expect(() =>
			parseSpellcastManifest(`
name: missing-entry
files:
  - Main.qml
`),
		).toThrow(/entry is required/i);
	});

	test("throws when entry is not listed in files", () => {
		expect(() =>
			parseSpellcastManifest(`
name: mismatched-entry
entry: Main.qml
files:
  - Other.qml
`),
		).toThrow(/entry must be included in files/i);
	});

	test("throws on invalid visibility", () => {
		expect(() =>
			parseSpellcastManifest(`
name: bad-visibility
entry: Main.qml
files:
  - Main.qml
visibility: private
`),
		).toThrow(/visibility must be one of/i);
	});

	test("throws on unknown tools", () => {
		expect(() =>
			parseSpellcastManifest(`
name: bad-tools
entry: Main.qml
files:
  - Main.qml
tools:
  - read
  - made_up_tool
`),
		).toThrow(/unknown tools/i);
	});
});

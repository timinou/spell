import { describe, expect, test } from "bun:test";
import { formatSpellcastSessionReport } from "@oh-my-pi/pi-coding-agent/spellcast/session-report";
import type { SpellcastSessionContext } from "@oh-my-pi/pi-coding-agent/spellcast";

function makeContext(overrides: Partial<SpellcastSessionContext> = {}): SpellcastSessionContext {
	return {
		discovery: { manifests: [], warnings: [] },
		discoveredManifests: [],
		publishState: {},
		...overrides,
	};
}

describe("formatSpellcastSessionReport", () => {
	test("formats published and draft manifests", () => {
		const report = formatSpellcastSessionReport(
			makeContext({
				discovery: { manifests: [], warnings: [] },
				discoveredManifests: [
					{
						manifestPath: "/proj/weather.spellcast.manifest.yaml",
						manifestDir: "/proj",
						manifest: {
							name: "weather",
							entry: "Main.qml",
							files: ["Main.qml"],
							visibility: "public",
							tools: ["read"],
							auto_sync: false,
						},
					},
					{
						manifestPath: "/proj/timer.spellcast.manifest.yaml",
						manifestDir: "/proj",
						manifest: {
							name: "timer",
							entry: "Timer.qml",
							files: ["Timer.qml"],
							visibility: "unlisted",
							tools: ["read"],
							auto_sync: false,
						},
					},
				],
				publishState: {
					"/proj/weather.spellcast.manifest.yaml": {
						manifestPath: "/proj/weather.spellcast.manifest.yaml",
						appId: "abc123",
						appUrl: "https://cast.spell.dev/share/abc123",
						visibility: "public",
						updatedAt: "2026-04-01T00:00:00Z",
					},
				},
			}),
		);

		expect(report).toContain("weather (published, https://cast.spell.dev/share/abc123)");
		expect(report).toContain("timer (draft)");
	});

	test("returns empty string when there are no manifests or warnings", () => {
		expect(formatSpellcastSessionReport(makeContext())).toBe("");
	});

	test("includes warnings when discovery reported problems", () => {
		const report = formatSpellcastSessionReport(
			makeContext({
				discovery: { manifests: [], warnings: ["Invalid spellcast manifest at /proj/bad.spellcast.manifest.yaml"] },
			}),
		);

		expect(report).toContain("Spellcast warnings (1)");
		expect(report).toContain("bad.spellcast.manifest.yaml");
	});
});

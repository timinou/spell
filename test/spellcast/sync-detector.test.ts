import { describe, expect, it } from "bun:test";
import { checkFileAgainstManifests } from "@oh-my-pi/pi-coding-agent/spellcast/sync-detector";
import type { SpellcastSessionContext } from "@oh-my-pi/pi-coding-agent/spellcast";

function makeContext(): SpellcastSessionContext {
	return {
		discovery: { manifests: [], warnings: [] },
		discoveredManifests: [
			{
				manifestPath: "/proj/app.spellcast.manifest.yaml",
				manifestDir: "/proj",
				manifest: {
					name: "app",
					entry: "Main.qml",
					files: ["Main.qml", "data.json"],
					visibility: "public",
					tools: ["read"],
					auto_sync: false,
				},
			},
		],
		publishState: {
			"/proj/app.spellcast.manifest.yaml": {
				manifestPath: "/proj/app.spellcast.manifest.yaml",
				appId: "abc123",
				appUrl: "https://cast.spell.dev/share/abc123",
				visibility: "public",
				updatedAt: "2026-04-01T00:00:00Z",
			},
		},
	};
}

describe("checkFileAgainstManifests", () => {
	it("detects writes to published spellcast files", () => {
		const match = checkFileAgainstManifests("/proj/Main.qml", makeContext());
		expect(match).not.toBeNull();
		expect(match?.manifestName).toBe("app");
		expect(match?.url).toContain("abc123");
	});

	it("ignores unrelated files", () => {
		expect(checkFileAgainstManifests("/proj/other.ts", makeContext())).toBeNull();
	});

	it("ignores files from unpublished spellcasts", () => {
		const context = makeContext();
		context.publishState = {};
		expect(checkFileAgainstManifests("/proj/Main.qml", context)).toBeNull();
	});
});

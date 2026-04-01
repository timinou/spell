import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CanvasCastTool } from "../../packages/coding-agent/src/tools/canvas-cast";

function makeSession(cwd: string, token: string | null) {
	return {
		cwd,
		authStorage: {
			getApiKey: async () => token ?? undefined,
		},
		getSessionId: () => "test-session",
	} as never;
}

describe("CanvasCastTool", () => {
	let cwd = "";
	let manifestPath = "";

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "spellcast-tool-"));
		manifestPath = path.join(cwd, "weather.spellcast.manifest.yaml");
		await Bun.write(
			manifestPath,
			"name: weather-widget\nentry: Main.qml\nfiles:\n  - Main.qml\n  - data.json\nvisibility: public\n",
		);
		await Bun.write(path.join(cwd, "Main.qml"), "import QtQuick\nRectangle {}");
		await Bun.write(path.join(cwd, "data.json"), "{}");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (cwd) {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("publish uploads tarball and stores association", async () => {
		const tool = new CanvasCastTool(makeSession(cwd, "tok_abc"));
		spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify({ id: "abc123", url: "https://cast.spell.dev/share/abc123" }), {
				status: 201,
				headers: { "content-type": "application/json" },
			}),
		);

		const result = await tool.execute("call-1", { action: "publish", manifest: manifestPath });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("https://cast.spell.dev/share/abc123");
		const state = JSON.parse(await Bun.file(path.join(cwd, ".local", "spellcast-state.json")).text()) as Record<string, { appId: string }>;
		expect(state[manifestPath]?.appId).toBe("abc123");
	});

	it("publish fails without auth token", async () => {
		const tool = new CanvasCastTool(makeSession(cwd, null));
		const result = await tool.execute("call-1", { action: "publish", manifest: manifestPath });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Not authenticated");
	});

	it("update uploads tarball for existing app", async () => {
		await fs.mkdir(path.join(cwd, ".local"), { recursive: true });
		await Bun.write(
			path.join(cwd, ".local", "spellcast-state.json"),
			JSON.stringify({
				[manifestPath]: {
					manifestPath,
					appId: "abc123",
					appUrl: "https://cast.spell.dev/share/abc123",
					visibility: "public",
					updatedAt: "2026-04-01T00:00:00Z",
				},
			}),
		);
		const tool = new CanvasCastTool(makeSession(cwd, "tok_abc"));
		spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify({ id: "abc123", url: "https://cast.spell.dev/share/abc123" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const result = await tool.execute("call-1", { action: "update", manifest: manifestPath });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Updated weather-widget");
	});

	it("update fails when spellcast is not published", async () => {
		const tool = new CanvasCastTool(makeSession(cwd, "tok_abc"));
		const result = await tool.execute("call-1", { action: "update", manifest: manifestPath });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("not published yet");
	});

	it("unpublish deletes app and clears local state", async () => {
		await fs.mkdir(path.join(cwd, ".local"), { recursive: true });
		await Bun.write(
			path.join(cwd, ".local", "spellcast-state.json"),
			JSON.stringify({
				[manifestPath]: {
					manifestPath,
					appId: "abc123",
					appUrl: "https://cast.spell.dev/share/abc123",
					visibility: "public",
					updatedAt: "2026-04-01T00:00:00Z",
				},
			}),
		);
		const tool = new CanvasCastTool(makeSession(cwd, "tok_abc"));
		spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 204 }));

		const result = await tool.execute("call-1", { action: "unpublish", manifest: manifestPath });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Unpublished");
		const state = JSON.parse(await Bun.file(path.join(cwd, ".local", "spellcast-state.json")).text()) as Record<string, unknown>;
		expect(state[manifestPath]).toBeUndefined();
	});

	it("status lists discovered manifests with publish state", async () => {
		await fs.mkdir(path.join(cwd, ".local"), { recursive: true });
		await Bun.write(
			path.join(cwd, ".local", "spellcast-state.json"),
			JSON.stringify({
				[manifestPath]: {
					manifestPath,
					appId: "abc123",
					appUrl: "https://cast.spell.dev/share/abc123",
					visibility: "public",
					updatedAt: "2026-04-01T00:00:00Z",
				},
			}),
		);
		const tool = new CanvasCastTool(makeSession(cwd, "tok_abc"));
		const result = await tool.execute("call-1", { action: "status" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("weather-widget: published https://cast.spell.dev/share/abc123");
	});
});

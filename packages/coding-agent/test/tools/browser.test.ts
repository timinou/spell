import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BrowserTool } from "@oh-my-pi/pi-coding-agent/tools/browser";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "browser.headless": true }),
	};
}

describe("BrowserTool screenshot artifacts", () => {
	let tmpDir: string;
	let tool: BrowserTool;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-tool-"));
		tool = new BrowserTool(createSession(tmpDir));
	});

	afterEach(async () => {
		await tool.dispose();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	async function openFixturePage(): Promise<void> {
		const html = [
			"<!doctype html>",
			"<html>",
			"<body>",
			"<main>",
			"<h1>Screenshot target</h1>",
			"<p>Persistent artifact proof</p>",
			"</main>",
			"</body>",
			"</html>",
		].join("");
		const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

		await tool.execute("open-browser", { action: "open" });
		await tool.execute("goto-page", { action: "goto", url });
	}

	it("writes screenshots to the requested path relative to cwd", async () => {
		await openFixturePage();

		const result = await tool.execute("capture-shot", {
			action: "screenshot",
			path: "plan-artifacts/PLAN-001-proof/landing.png",
		});
		const expectedPath = path.join(tmpDir, "plan-artifacts", "PLAN-001-proof", "landing.png");
		const bytes = await Bun.file(expectedPath).bytes();

		expect(result.details?.screenshotPath).toBe(expectedPath);
		expect(result.details?.mimeType).toBe("image/png");
		expect(result.details?.bytes).toBe(bytes.length);
		expect(Array.from(bytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
	});

	it("rejects requested paths with a non-png extension", async () => {
		await openFixturePage();

		await expect(
			tool.execute("capture-shot-bad-path", {
				action: "screenshot",
				path: "plan-artifacts/PLAN-001-proof/landing.jpg",
			}),
		).rejects.toThrow("Screenshot path must end in .png because browser screenshots are saved as PNG files.");
	});
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import type { ToolSession } from "@spell/pi-coding-agent/tools";
import { BrowserTool } from "@spell/pi-coding-agent/tools/browser";

function createSession(cwd: string, artifactsDir: string): ToolSession {
	let nextArtifactId = 0;
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "browser.headless": true }),
		allocateOutputArtifact: async (toolType, extension) => {
			const id = String(nextArtifactId++);
			const ext = extension ?? "txt";
			const dir = path.join(artifactsDir, toolType);
			await fs.mkdir(dir, { recursive: true });
			return {
				id,
				path: path.join(dir, `${id}.${ext}`),
				uri: `artifact://test/main/${toolType}/${id}.${ext}`,
			};
		},
	};
}

describe("BrowserTool screenshot artifacts", () => {
	let tmpDir: string;
	let artifactsDir: string;
	let tool: BrowserTool;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-tool-"));
		artifactsDir = path.join(tmpDir, "session-artifacts");
		tool = new BrowserTool(createSession(tmpDir, artifactsDir));
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

	it("stores screenshots in the artifact directory when no explicit path is provided", async () => {
		await openFixturePage();

		const result = await tool.execute("capture-artifact-shot", {
			action: "screenshot",
		});
		const artifactPath = path.join(artifactsDir, "screenshot", "0.png");
		const bytes = await Bun.file(artifactPath).bytes();

		expect(result.details?.screenshotPath).toBe(artifactPath);
		expect(result.details?.artifactUri).toBe("artifact://test/main/screenshot/0.png");
		expect(result.details?.mimeType).toBe("image/png");
		expect(result.details?.bytes).toBe(bytes.length);
		expect(Array.from(bytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
	});

	it("writes screenshots to both the requested path and the artifact directory", async () => {
		await openFixturePage();

		const result = await tool.execute("capture-shot", {
			action: "screenshot",
			path: "plan-artifacts/PLAN-001-proof/landing.png",
		});
		const requestedPath = path.join(tmpDir, "plan-artifacts", "PLAN-001-proof", "landing.png");
		const artifactPath = path.join(artifactsDir, "screenshot", "0.png");
		const requestedBytes = await Bun.file(requestedPath).bytes();
		const artifactBytes = await Bun.file(artifactPath).bytes();

		expect(result.details?.screenshotPath).toBe(requestedPath);
		expect(result.details?.artifactUri).toBe("artifact://test/main/screenshot/0.png");
		expect(result.details?.mimeType).toBe("image/png");
		expect(result.details?.bytes).toBe(requestedBytes.length);
		expect(artifactBytes).toEqual(requestedBytes);
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

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeCanvasLaunchRequest } from "../../src/tools/canvas";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-launch-normalization-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("normalizeCanvasLaunchRequest", () => {
	it("normalizes open directory targets to a deterministic launch request", async () => {
		await withTempDir(async tempDir => {
			const extensionDir = path.join(tempDir, ".spell", "extensions", "phoenix-inspector");
			await fs.mkdir(extensionDir, { recursive: true });
			await Bun.write(path.join(extensionDir, "inspector.qml"), "import QtQuick 2.15\n");

			const result = await normalizeCanvasLaunchRequest(
				{ action: "open", path: ".spell/extensions/phoenix-inspector/" },
				filePath => Promise.resolve(path.join(tempDir, filePath)),
			);

			expect(result).toEqual({
				action: "launch",
				id: "phoenix-inspector",
				path: path.join(extensionDir, "inspector.qml"),
			});
		});
	});

	it("derives the parent directory id for inspector.qml launches without an explicit id", async () => {
		await withTempDir(async tempDir => {
			const qmlPath = path.join(tempDir, ".spell", "extensions", "phoenix-inspector", "inspector.qml");
			await fs.mkdir(path.dirname(qmlPath), { recursive: true });
			await Bun.write(qmlPath, "import QtQuick 2.15\n");

			const result = await normalizeCanvasLaunchRequest({ action: "launch", path: qmlPath }, filePath =>
				Promise.resolve(filePath),
			);

			expect(result?.id).toBe("phoenix-inspector");
			expect(result?.path).toBe(qmlPath);
		});
	});

	it("rejects ambiguous directory targets without a deterministic QML entrypoint", async () => {
		await withTempDir(async tempDir => {
			const panelDir = path.join(tempDir, "panel-set");
			await fs.mkdir(panelDir, { recursive: true });
			await Bun.write(path.join(panelDir, "alpha.qml"), "import QtQuick 2.15\n");
			await Bun.write(path.join(panelDir, "beta.qml"), "import QtQuick 2.15\n");

			await expect(
				normalizeCanvasLaunchRequest({ action: "launch", path: panelDir }, filePath => Promise.resolve(filePath)),
			).rejects.toThrow("deterministic entrypoint");
		});
	});
});

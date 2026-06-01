import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isBridgeAvailable } from "@spell/pi-qml";
import { Settings } from "../../src/config/settings";
import { CanvasProtocolHandler, InternalUrlRouter } from "../../src/internal-urls";
import type { ToolSession } from "../../src/tools";
import { CanvasTool } from "../../src/tools/canvas";

const SIMPLE_QML = `
import QtQuick 2.15
import QtQuick.Controls 2.15
ApplicationWindow {
	visible: true
	width: 320
	height: 200
	Text { anchors.centerIn: parent; text: "Session URL" }
}
`;

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-tool-session-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

function createSession(options: {
	cwd: string;
	artifactsDir: string;
	sessionId: string;
	internalRouter: InternalUrlRouter;
}): ToolSession {
	return {
		cwd: options.cwd,
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => options.artifactsDir,
		getSessionId: () => options.sessionId,
		internalRouter: options.internalRouter,
	};
}

describe.skipIf(!isBridgeAvailable())("CanvasTool session URL support", () => {
	const windowId = "canvas-session-url-test";

	afterEach(async () => {
		// Best-effort cleanup in case a test fails before close.
		const fallback = new CanvasTool(
			createSession({
				cwd: process.cwd(),
				artifactsDir: path.join(os.tmpdir(), "unused-artifacts"),
				sessionId: "cleanup",
				internalRouter: new InternalUrlRouter(),
			}),
		);
		try {
			await fallback.execute("cleanup", { action: "close", id: windowId });
		} catch {
			// ignore
		}
		await fallback.dispose();
	});

	it("writes canvas://session file and launches it via canvas://session path", async () => {
		await withTempDir(async tempDir => {
			const artifactsDir = path.join(tempDir, "artifacts");
			const stdlibRoot = path.join(tempDir, "stdlib");
			const sessionId = "session-url";
			const router = new InternalUrlRouter();
			router.register(
				new CanvasProtocolHandler({
					getStdlibRoot: () => stdlibRoot,
					getArtifactsDir: () => artifactsDir,
					getSessionId: () => sessionId,
				}),
			);
			const tool = new CanvasTool(createSession({ cwd: tempDir, artifactsDir, sessionId, internalRouter: router }));
			const canvasUrl = "canvas://session/views/panel.qml";

			await tool.execute("call-write", { action: "write", path: canvasUrl, content: SIMPLE_QML });
			const launchResult = await tool.execute("call-launch", {
				action: "launch",
				id: windowId,
				path: canvasUrl,
				width: 320,
				height: 200,
			});

			expect(launchResult.details?.action).toBe("launch");
			expect(launchResult.details?.windowId).toBe(windowId);

			await tool.execute("call-close", { action: "close", id: windowId });
			await tool.dispose();
		});
	});
});

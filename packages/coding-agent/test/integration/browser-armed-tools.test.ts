import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { isBridgeAvailable, QmlProcess } from "@spell/pi-qml";
import { BrowserJourney } from "../helpers/browser-journey";

const BROWSER_QML = path.resolve(import.meta.dir, "../../src/modes/qml/canvas/BrowserWindow.qml");

function createProcess(): QmlProcess {
	return new QmlProcess({
		env: {
			QT_QPA_PLATFORM: "offscreen",
			QTWEBENGINE_DISABLE_SANDBOX: "1",
			QTWEBENGINE_CHROMIUM_FLAGS: "--no-sandbox",
		},
	});
}

describe.skipIf(!isBridgeAvailable())("Browser armed tools", () => {
	it("declares the default armed tools on ready", async () => {
		const proc = createProcess();
		const windowId = `browser-armed-${Date.now()}`;
		try {
			await proc.spawnStdio();
			proc.send({
				type: "load",
				id: windowId,
				path: BROWSER_QML,
				props: {
					initialUrl: "about:blank",
					settingsFile: "/tmp/browser-armed-tools.ini",
				},
				title: "Browser",
				width: 900,
				height: 700,
			});
			const ready = await proc.waitFor(event => event.type === "ready" && event.id === windowId, 15_000);
			expect((ready as { armedTools?: string[] }).armedTools).toEqual(["read", "write", "grep", "find"]);
			proc.send({ type: "close", id: windowId });
			await proc.waitFor(event => event.type === "closed" && event.id === windowId, 10_000);
		} finally {
			await proc.dispose();
		}
	});

	it("can emit an armed-tool payload from the browser window context", async () => {
		const browser = await BrowserJourney.launch();
		try {
			const payload = await browser.emitToolInvocation({
				_tool: "read",
				_rid: "tool-read-1",
				path: "package.json",
			});
			expect(payload._tool).toBe("read");
			expect(payload._rid).toBe("tool-read-1");
			expect(payload.path).toBe("package.json");
		} finally {
			await browser.teardown();
		}
	});
});

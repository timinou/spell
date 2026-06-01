import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { isBridgeAvailable, QmlProcess } from "@spell/pi-qml";

const SIMPLE_QML = `
import QtQuick 2.15
import QtQuick.Controls 2.15
ApplicationWindow {
    visible: true
    width: 400
    height: 300
    Text { anchors.centerIn: parent; text: "Test" }
    Connections {
        target: bridge
        function onMessageReceived(payload) {
            if (payload.action === 'close_self') {
                bridge.send({ action: 'close' })
                Qt.quit()
            }
        }
    }
}
`;

describe.skipIf(!isBridgeAvailable())("QML WM-close detection", () => {
	let proc: QmlProcess;
	let qmlPath: string;

	beforeEach(async () => {
		proc = new QmlProcess({ env: { QT_QPA_PLATFORM: "offscreen" } });
		await proc.spawnStdio();
		qmlPath = path.join(os.tmpdir(), `wm-close-test-${Date.now()}.qml`);
		await Bun.write(qmlPath, SIMPLE_QML);
	});

	afterEach(async () => {
		await proc.dispose();
	});

	it("user-initiated close (via close action) reports closed: true", async () => {
		proc.send({ type: "load", id: "wm-test", path: qmlPath, props: {}, title: "Test", width: 400, height: 300 });
		await proc.waitFor(e => e.type === "ready" && e.id === "wm-test", 10_000);

		// Send close_self message which causes QML to send close action then Qt.quit()
		proc.send({ type: "message", id: "wm-test", payload: { action: "close_self" } });
		const ev = await proc.waitFor(
			e => e.type === "event" && e.id === "wm-test" && (e as any).payload?.action === "close",
			5_000,
		);
		expect((ev as any).payload.action).toBe("close");
	});

	it("bridge close command sends closed event", async () => {
		proc.send({ type: "load", id: "wm-test2", path: qmlPath, props: {}, title: "Test", width: 400, height: 300 });
		await proc.waitFor(e => e.type === "ready" && e.id === "wm-test2", 10_000);

		// Close from bridge side
		proc.send({ type: "close", id: "wm-test2" });
		const ev = await proc.waitFor(e => e.type === "closed" && e.id === "wm-test2", 5_000);
		expect(ev.type).toBe("closed");
		expect((ev as { type: "closed"; id: string }).id).toBe("wm-test2");
	});
});

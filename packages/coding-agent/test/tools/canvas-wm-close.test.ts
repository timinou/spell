import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { isBridgeAvailable, QmlBridge } from "@oh-my-pi/pi-qml";

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
	let bridge: QmlBridge;
	let qmlPath: string;

	beforeEach(async () => {
		bridge = new QmlBridge({ env: { QT_QPA_PLATFORM: "offscreen" } });
		qmlPath = path.join(os.tmpdir(), `wm-close-test-${Date.now()}.qml`);
		await Bun.write(qmlPath, SIMPLE_QML);
	});

	afterEach(async () => {
		await bridge.dispose();
	});

	it("user-initiated close (via close action) reports closed: true", async () => {
		await bridge.launch("wm-test", qmlPath, {});
		// Drain any initial events
		bridge.drainEvents("wm-test");
		// Send close_self message which causes QML to send close action then Qt.quit()
		void bridge.sendMessage("wm-test", { action: "close_self" });
		const events = await bridge.waitForEvent("wm-test", 5000);
		const hasClose = events.some(e => (e.payload as Record<string, unknown>).action === "close");
		expect(hasClose).toBe(true);
	});

	it("WM close without prior close event window closes and reports closed state", async () => {
		await bridge.launch("wm-test2", qmlPath, {});
		bridge.drainEvents("wm-test2");
		// Force close from bridge side (simulates WM kill)
		await bridge.close("wm-test2");
		const win = bridge.getWindow("wm-test2");
		expect(win?.state).toBe("closed");
	});
});

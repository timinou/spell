import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { isBridgeAvailable, QmlTestHarness } from "@oh-my-pi/pi-qml";
import * as path from "node:path";

// ChatDrawer is tested via the shell harness which includes a collapsed chat bar.
const HARNESS = path.resolve(import.meta.dir, "../../src/qml/panels/GrowthShellTestHarness.qml");

describe.skipIf(!isBridgeAvailable())("Chat Drawer", () => {
	const harness = new QmlTestHarness();

	beforeAll(async () => {
		await harness.setup(HARNESS);
	});
	afterAll(async () => {
		await harness.teardown();
	});
	beforeEach(async () => {
		await harness.reset();
	});

	test("shell renders a chat area rectangle", async () => {
		await Bun.sleep(300);
		// The chat bar is a 56px-tall Rectangle in the layout
		const rects = await harness.findItems({ type: "QQuickRectangle", visible: true }, { includeGeometry: true });
		const chatBar = rects.find((r) => r.geometry && Math.abs(r.geometry.height - 56) < 10);
		expect(chatBar).toBeDefined();
	});

	test("chat label is rendered somewhere in the shell", async () => {
		await Bun.sleep(300);
		// Use findItems with textContains which checks Label (QQuickLabel inherits QQuickText)
		const items = await harness.findItems({ textContains: "Chat", visible: true });
		expect(items.length).toBeGreaterThan(0);
	});
});

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

	test("shell renders a ChatDrawer with collapsed height", async () => {
		await Bun.sleep(300);
		// ChatDrawer is a custom Rectangle subclass — find it via its property
		const items = await harness.findItems({ visible: true }, { includeGeometry: true, properties: ["collapsedHeight"] });
		const chatDrawer = items.find((r) => r.properties.collapsedHeight === 56 && r.geometry && Math.abs(r.geometry.height - 56) < 10);
		expect(chatDrawer).toBeDefined();
	});

	test("chat label is rendered somewhere in the shell", async () => {
		await Bun.sleep(300);
		// Use findItems with textContains which checks Label (QQuickLabel inherits QQuickText)
		const items = await harness.findItems({ textContains: "Chat", visible: true });
		expect(items.length).toBeGreaterThan(0);
	});
});

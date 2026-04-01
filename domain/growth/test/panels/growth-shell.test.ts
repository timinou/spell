import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { isBridgeAvailable, QmlTestHarness } from "@oh-my-pi/pi-qml";
import * as path from "node:path";
import growthDomain from "../../manifest";

const HARNESS = path.resolve(import.meta.dir, "../../src/qml/panels/GrowthShellTestHarness.qml");

describe.skipIf(!isBridgeAvailable())("Growth Shell", () => {
	const harness = new QmlTestHarness();

	beforeAll(async () => {
		await harness.setup(HARNESS, { workspaces: growthDomain.workspaces });
	});
	afterAll(async () => {
		await harness.teardown();
	});
	beforeEach(async () => {
		await harness.reset();
	});

	test("shell loads without error", async () => {
		await Bun.sleep(300);
		const items = await harness.findItems({ visible: true }, { includeGeometry: true });
		expect(items.length).toBeGreaterThan(0);
	});

	test("shell has sidebar (280px rectangle)", async () => {
		await Bun.sleep(300);
		const rects = await harness.findItems({ type: "QQuickRectangle", visible: true }, { includeGeometry: true });
		const sidebar = rects.find((r) => r.geometry && Math.abs(r.geometry.width - 280) < 10);
		expect(sidebar).toBeDefined();
	});

	test("renders placeholder text in main area", async () => {
		await Bun.sleep(300);
		const texts = await harness.findVisibleText();
		expect(texts).toContain("Select a workspace to begin");
	});

	test("workspace list model matches the manifest payload", async () => {
		await Bun.sleep(300);
		const count = await harness.evaluate<number>("root.workspaces.length");
		expect(count).toBe(growthDomain.workspaces.length);
	});

	test("renders manifest workspace names in the sidebar", async () => {
		await Bun.sleep(300);
		const items = await harness.findItems({ visible: true }, { properties: ["text"] });
		const texts = items
			.map(item => item.properties["text"])
			.filter((text): text is string => typeof text === "string");
		expect(texts).toContain(growthDomain.workspaces[0]?.name ?? "General");
		expect(texts).toContain(growthDomain.workspaces[1]?.name ?? "Research");
	});

	test("current workspace defaults to general", async () => {
		await Bun.sleep(300);
		const ws = await harness.evaluate<string>("root.currentWorkspaceId");
		expect(ws).toBe("general");
	});
});

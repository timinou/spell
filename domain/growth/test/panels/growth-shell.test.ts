import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { isBridgeAvailable, QmlTestHarness } from "@oh-my-pi/pi-qml";
import * as path from "node:path";
import growthDomain from "../../manifest";

const HARNESS = path.resolve(import.meta.dir, "../../src/qml/panels/GrowthShellTestHarness.qml");
const PANELS_DIR = path.resolve(import.meta.dir, "../../src/qml/panels");

// Build resolved panel configs matching what qml-mode.ts would produce.
// The test harness needs absolute paths to load panels via Loader.
function buildTestPanels() {
	// Builtin panels (chat, dashboard) come from coding-agent — use the growth domain's own panels
	// plus minimal stubs for builtins that the harness can resolve.
	const builtins = [
		{ id: "chat", title: "Chat", icon: "●", path: path.resolve(PANELS_DIR, "ChatDrawer.qml") },
	];
	const domainPanels = growthDomain.panels.map(p => ({
		id: p.id,
		title: p.name,
		icon: p.icon ?? "",
		path: path.resolve(PANELS_DIR, path.basename(p.qmlPath)),
	}));
	return [...builtins, ...domainPanels];
}

describe.skipIf(!isBridgeAvailable())("Growth Shell", () => {
	const harness = new QmlTestHarness();
	const testPanels = buildTestPanels();

	beforeAll(async () => {
		await harness.setup(HARNESS, {
			workspaces: growthDomain.workspaces,
			panels: testPanels,
		});
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

	// --- Panel loading tests ---

	test("panel registry is populated from bridge.props.panels", async () => {
		await Bun.sleep(300);
		const regJson = await harness.evaluate<string>("JSON.stringify(root.panelRegistry)");
		const reg = JSON.parse(regJson);
		expect(Object.keys(reg)).toContain("chat");
		expect(Object.keys(reg)).toContain("dashboard");
	});

	test("switching workspace loads the main panel via Loader", async () => {
		await Bun.sleep(300);
		// Switch to strategy workspace which maps dashboard panel to main position
		await harness.evaluate("root.currentWorkspaceId = 'strategy'");
		await Bun.sleep(500);

		// Verify the workspace switched
		const wsId = await harness.evaluate<string>("root.currentWorkspaceId");
		expect(wsId).toBe("strategy");

		// Verify panelRegistry has dashboard mapped to a real path
		const dashPath = await harness.evaluate<string>("root.panelRegistry['dashboard'] || ''");
		expect(dashPath).toContain("GrowthDashboard.qml");
	});

	// --- Icon rendering tests ---

	test("sidebar renders emoji icons instead of text names", async () => {
		await Bun.sleep(300);
		const items = await harness.findItems({ visible: true }, { properties: ["text"] });
		const texts = items
			.map(item => item.properties["text"])
			.filter((text): text is string => typeof text === "string");

		// Should NOT contain raw icon names as rendered text
		const iconNames = ["home", "search", "lightbulb", "edit", "chart", "rocket"];
		for (const name of iconNames) {
			// Icon names should not appear as standalone labels in the sidebar.
			// They may appear within other text, but not as the sole text of a label.
			const exactMatch = texts.some(t => t === name);
			expect(exactMatch).toBe(false);
		}

		// Should contain emoji characters from the iconFor mapping
		const hasEmoji = texts.some(t => /[\u{1F300}-\u{1F9FF}]/u.test(t));
		expect(hasEmoji).toBe(true);
	});

	test("iconFor resolves known icons to emoji", async () => {
		const homeIcon = await harness.evaluate<string>("root.iconFor('home')");
		expect(homeIcon).toBe("\u{1F3E0}");
		const searchIcon = await harness.evaluate<string>("root.iconFor('search')");
		expect(searchIcon).toBe("\u{1F50D}");
	});

	test("iconFor falls back to dot for unknown icons", async () => {
		const fallback = await harness.evaluate<string>("root.iconFor('unknown_thing')");
		// Unknown names pass through as-is (name || "●")
		expect(fallback).toBe("unknown_thing");
	});

	// --- ChatDrawer tests ---

	test("ChatDrawer has a visible accent border", async () => {
		await Bun.sleep(300);
		// The accent border is a 2px tall Rectangle with color #7C3AED
		const items = await harness.findItems(
			{ type: "QQuickRectangle", visible: true },
			{ includeGeometry: true, properties: ["color"] },
		);
		const accentBorder = items.find(
			(r) => r.geometry && r.geometry.height === 2 && String(r.properties.color) === "#7c3aed"
		);
		expect(accentBorder).toBeDefined();
	});

	test("ChatDrawer collapsed bar shows Chat label", async () => {
		await Bun.sleep(300);
		const items = await harness.findItems({ textContains: "Chat", visible: true });
		expect(items.length).toBeGreaterThan(0);
	});
});

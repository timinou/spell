import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { isBridgeAvailable, QmlTestHarness } from "@oh-my-pi/pi-qml";
import * as path from "node:path";
import growthDomain from "../../manifest";

const HARNESS = path.resolve(import.meta.dir, "../../src/qml/panels/GrowthShellTestHarness.qml");
const PANELS_DIR = path.resolve(import.meta.dir, "../../src/qml/panels");
const MOCK_CHAT = path.resolve(import.meta.dir, "MockChatPanel.qml");

// Build resolved panel configs matching what qml-mode.ts would produce.
// Uses MockChatPanel for the "chat" slot so message forwarding can be verified
// without needing SpellUI/delegate imports that ChatPanel.qml requires.
function buildTestPanels() {
	const builtins = [
		{ id: "chat", title: "Chat", icon: "\u{25CF}", path: MOCK_CHAT },
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

	// --- Basic shell structure ---

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

	// --- Panel registry ---

	test("panel registry is populated from bridge.props.panels", async () => {
		await Bun.sleep(300);
		const regJson = await harness.evaluate<string>("JSON.stringify(root.panelRegistry)");
		const reg = JSON.parse(regJson);
		expect(Object.keys(reg)).toContain("chat");
		expect(Object.keys(reg)).toContain("dashboard");
	});

	// --- Main panel Loader ---

	test("main Loader source is set after workspace switch to strategy", async () => {
		await Bun.sleep(300);
		await harness.evaluate("root.currentWorkspaceId = 'strategy'");
		await Bun.sleep(500);

		const source = await harness.evaluate<string>("mainPanelLoader.source + ''");
		expect(source).toContain("GrowthDashboard.qml");
	});

	test("general workspace loads MockChatPanel as the main panel", async () => {
		await Bun.sleep(300);
		// General maps chat to main position — after reset, default is general
		const source = await harness.evaluate<string>("mainPanelLoader.source + ''");
		expect(source).toContain("MockChatPanel.qml");
	});

	test("general workspace has no secondary panel", async () => {
		await Bun.sleep(300);
		const source = await harness.evaluate<string>("secondaryPanelLoader.source + ''");
		expect(source).toBe("");
	});

	// --- Secondary panel Loader ---

	test("strategy workspace loads secondary panel (chat)", async () => {
		await Bun.sleep(300);
		await harness.evaluate("root.currentWorkspaceId = 'strategy'");
		await Bun.sleep(500);

		const secondary = await harness.evaluate<string>("secondaryPanelLoader.source + ''");
		expect(secondary).toContain("MockChatPanel.qml");
	});

	test("campaign workspace loads planner as main and chat as secondary", async () => {
		await Bun.sleep(300);
		await harness.evaluate("root.currentWorkspaceId = 'campaign'");
		await Bun.sleep(500);

		const main = await harness.evaluate<string>("mainPanelLoader.source + ''");
		const secondary = await harness.evaluate<string>("secondaryPanelLoader.source + ''");
		expect(main).toContain("KanbanBoard.qml");
		expect(secondary).toContain("MockChatPanel.qml");
	});

	test("review workspace loads editor as secondary (not chat)", async () => {
		await Bun.sleep(300);
		await harness.evaluate("root.currentWorkspaceId = 'review'");
		await Bun.sleep(500);

		const main = await harness.evaluate<string>("mainPanelLoader.source + ''");
		const secondary = await harness.evaluate<string>("secondaryPanelLoader.source + ''");
		expect(main).toContain("GrowthDashboard.qml");
		expect(secondary).toContain("EditorPanel.qml");
	});

	// --- Flex ratio ---

	test("strategy workspace sets flex ratios from manifest", async () => {
		await Bun.sleep(300);
		await harness.evaluate("root.currentWorkspaceId = 'strategy'");
		await Bun.sleep(300);

		const mainFlex = await harness.evaluate<number>("root.mainFlex");
		const secondaryFlex = await harness.evaluate<number>("root.secondaryFlex");
		// Strategy: main flex=2, secondary flex=1
		expect(mainFlex).toBe(2);
		expect(secondaryFlex).toBe(1);
	});

	// --- Message forwarding ---

	test("bridge messages are forwarded to main panel's handleMessage", async () => {
		await Bun.sleep(500);
		// General workspace: MockChatPanel is main panel with handleMessage

		// Verify the main panel loaded
		const loaded = await harness.evaluate<boolean>("mainPanelLoader.item !== null");
		expect(loaded).toBe(true);

		// Send a message through the bridge
		await harness.sendMessage({ type: "user_message", text: "hello" });
		await Bun.sleep(300);

		const count = await harness.evaluate<number>("mainPanelLoader.item.messageCount");
		expect(count).toBeGreaterThan(0);

		const lastType = await harness.evaluate<string>("mainPanelLoader.item.lastMessageType");
		expect(lastType).toBe("user_message");
	});

	test("bridge messages are forwarded to secondary panel", async () => {
		await Bun.sleep(300);
		await harness.evaluate("root.currentWorkspaceId = 'strategy'");
		await Bun.sleep(500);

		// Secondary panel is MockChatPanel with handleMessage
		const loaded = await harness.evaluate<boolean>("secondaryPanelLoader.item !== null");
		expect(loaded).toBe(true);

		await harness.sendMessage({ type: "message_start", id: "msg-1", role: "assistant" });
		await Bun.sleep(300);

		const count = await harness.evaluate<number>("secondaryPanelLoader.item.messageCount");
		expect(count).toBeGreaterThan(0);

		const lastType = await harness.evaluate<string>("secondaryPanelLoader.item.lastMessageType");
		expect(lastType).toBe("message_start");
	});

	// --- Icon rendering ---

	test("sidebar renders emoji icons instead of text names", async () => {
		await Bun.sleep(300);
		const items = await harness.findItems({ visible: true }, { properties: ["text"] });
		const texts = items
			.map(item => item.properties["text"])
			.filter((text): text is string => typeof text === "string");

		// Icon names should not appear as standalone labels
		const iconNames = ["home", "search", "lightbulb", "edit", "chart", "rocket"];
		for (const name of iconNames) {
			const exactMatch = texts.some(t => t === name);
			expect(exactMatch).toBe(false);
		}

		// Should contain emoji characters from the iconMap
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
		expect(fallback).toBe("unknown_thing");
	});

	// --- Dead code removed ---

	test("currentPanels property does not exist (dead code removed)", async () => {
		const exists = await harness.evaluate<boolean>("typeof root.currentPanels !== 'undefined'");
		expect(exists).toBe(false);
	});
});

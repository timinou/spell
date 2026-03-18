/**
 * PROJ-F integration test: Shell sidebar click interaction.
 * Exercises observe() + clickId() to navigate panels via sidebar clicks,
 * and verifies switchPanel() as a higher-level alternative.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { isBridgeAvailable, QmlJourney } from "../helpers/qml-journey";

const SHELL_QML = "shell.qml";

describe.skipIf(!isBridgeAvailable())("Shell Sidebar Interaction", () => {
	let journey: QmlJourney;

	beforeAll(async () => {
		journey = await QmlJourney.launch(SHELL_QML, {
			props: {
				panels: [
					{ id: "chat", title: "Chat", icon: "\u25cf", path: "panels/ChatPanel.qml" },
					{ id: "dashboard", title: "Dashboard", icon: "\u25a0", path: "panels/DashboardPanel.qml" },
				],
			},
		});
		await journey.settle(100);
	});

	afterAll(async () => {
		await journey.teardown();
	});

	it("observe returns interactive elements including sidebar", async () => {
		const elements = await journey.observe();
		// Should have MouseAreas for sidebar panel items
		const mouseAreas = elements.filter(e => e.className.startsWith("QQuickMouseArea"));
		expect(mouseAreas.length).toBeGreaterThanOrEqual(2);
	});

	it("clicking dashboard sidebar item switches active panel", async () => {
		// Start on chat (index 0)
		const idx0 = await journey.evaluate<number>("root.activePanelIndex");
		expect(idx0).toBe(0);

		// Find sidebar items — they are small-height MouseAreas (sidebar delegates are height: 44)
		const elements = await journey.observe();
		const sidebarItems = elements.filter(e => e.className.startsWith("QQuickMouseArea") && e.geometry.height === 44);
		expect(sidebarItems.length).toBeGreaterThanOrEqual(2);

		// Click the second sidebar item (Dashboard)
		await journey.clickId(sidebarItems[1].id);

		const idx1 = await journey.evaluate<number>("root.activePanelIndex");
		expect(idx1).toBe(1);
	});

	it("switchPanel navigates correctly by panel id", async () => {
		// Navigate to dashboard
		await journey.switchPanel("dashboard");
		const idxDash = await journey.evaluate<number>("root.activePanelIndex");
		expect(idxDash).toBe(1);

		// Navigate back to chat
		await journey.switchPanel("chat");
		const idxChat = await journey.evaluate<number>("root.activePanelIndex");
		expect(idxChat).toBe(0);
	});
});

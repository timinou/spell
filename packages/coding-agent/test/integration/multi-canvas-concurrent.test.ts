/**
 * PROJ-F integration test: Multiple canvas panels and concurrent orchestrators.
 * Verifies independent panel updates and dashboard multi-orchestrator display.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { isBridgeAvailable, QmlJourney } from "../helpers/qml-journey";

const SHELL_QML = "shell.qml";

describe.skipIf(!isBridgeAvailable())("Multi-Canvas Concurrent", () => {
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

	it("adds two panels via agentSends", async () => {
		await journey.agentSends({
			type: "add_panel",
			id: "panel-a",
			title: "Panel A",
			icon: "A",
			path: "panels/DashboardPanel.qml",
		});
		await journey.agentSends({
			type: "add_panel",
			id: "panel-b",
			title: "Panel B",
			icon: "B",
			path: "panels/DashboardPanel.qml",
		});

		// Both panel titles should appear in the sidebar
		await journey.expectText("Panel A");
		await journey.expectText("Panel B");
	});

	it("dashboard shows both orchestrators simultaneously", async () => {
		// Switch to dashboard
		await journey.switchPanel("dashboard");

		await journey.agentSends({
			type: "dashboard_update",
			agent: { status: "busy", elapsed: "3s" },
			queue: { p1: 0, p2: 0, p3: 0 },
			orchestrators: [
				{ windowId: "win-a", scope: "Analyze module A" },
				{ windowId: "win-b", scope: "Analyze module B" },
			],
			windows: [],
			tokens: 500,
		});

		await journey.expectText("Analyze module A");
		await journey.expectText("Analyze module B");
	});

	it("removing one orchestrator leaves the other", async () => {
		await journey.agentSends({
			type: "dashboard_update",
			agent: { status: "busy", elapsed: "8s" },
			queue: { p1: 0, p2: 0, p3: 0 },
			orchestrators: [{ windowId: "win-b", scope: "Analyze module B" }],
			windows: [],
			tokens: 800,
		});

		// Only module B remains
		await journey.expectText("Analyze module B");
		await journey.expectTextAbsent("Analyze module A");
	});

	it("panel list length matches total panels", async () => {
		// We have: chat, dashboard, panel-a, panel-b = 4 panels
		const panelCount = await journey.evaluate<number>("root.panels.length");
		expect(panelCount).toBe(4);
	});
});

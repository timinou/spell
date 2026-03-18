/**
 * PROJ-F integration test: Chat to Canvas to Orchestrator flow.
 * Verifies add_panel, panel navigation, dashboard orchestrator display.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { isBridgeAvailable, QmlJourney } from "../helpers/qml-journey";

const SHELL_QML = "shell.qml";

describe.skipIf(!isBridgeAvailable())("Canvas Orchestrator Flow", () => {
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

	it("agent sends add_panel and sidebar shows new panel title", async () => {
		await journey.agentSends({
			type: "add_panel",
			id: "code-review",
			title: "Code Review",
			icon: "\u25b6",
			path: "panels/DashboardPanel.qml", // reuse dashboard for test
		});
		// The sidebar should now contain "Code Review" text
		await journey.expectText("Code Review");
	});

	it("agent sends dashboard_update with orchestrator and dashboard shows scope", async () => {
		// Switch to dashboard panel
		await journey.switchPanel("dashboard");
		await journey.agentSends({
			type: "dashboard_update",
			agent: { status: "busy", elapsed: "5s" },
			queue: { p1: 0, p2: 0, p3: 0 },
			orchestrators: [{ windowId: "win-1", scope: "Review auth module" }],
			windows: [],
			tokens: 1500,
		});
		// Verify orchestrator scope is visible
		await journey.expectText("Review auth module");
		// Verify agent status
		await journey.expectText("Agent is busy");
	});

	it("agent sends dashboard_update clearing orchestrator", async () => {
		await journey.agentSends({
			type: "dashboard_update",
			agent: { status: "idle", elapsed: "" },
			queue: { p1: 0, p2: 0, p3: 0 },
			orchestrators: [],
			windows: [],
			tokens: 2000,
		});
		// Verify orchestrator is gone — "No active orchestrators" should appear
		await journey.expectText("No active orchestrators");
		await journey.expectText("Agent is idle");
	});

	it("screenshot captures final state", async () => {
		const screenshotPath = await journey.screenshot("canvas-orchestrator-flow.png");
		expect(screenshotPath).toContain("canvas-orchestrator-flow.png");
	});
});

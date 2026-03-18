/**
 * PROJ-F integration test: Escalation flow UI response.
 * Verifies the QML dashboard correctly reflects orchestrator status transitions
 * that occur during an escalation. Does NOT invoke the actual orchestrator engine.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { isBridgeAvailable, QmlJourney } from "../helpers/qml-journey";

const SHELL_QML = "shell.qml";

describe.skipIf(!isBridgeAvailable())("Escalation Flow", () => {
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
		// Switch to dashboard immediately
		await journey.settle(100);
		await journey.switchPanel("dashboard");
	});

	afterAll(async () => {
		await journey.teardown();
	});

	it("initial orchestrator with scope appears in dashboard", async () => {
		await journey.agentSends({
			type: "dashboard_update",
			agent: { status: "busy", elapsed: "2s" },
			queue: { p1: 0, p2: 0, p3: 0 },
			orchestrators: [{ windowId: "orch-1", scope: "Review diff for auth" }],
			windows: [],
			tokens: 100,
		});

		await journey.expectText("Review diff for auth");
	});

	it("orchestrator status update during escalation is reflected", async () => {
		// Simulate in-progress escalation: scope changes to indicate status
		await journey.agentSends({
			type: "dashboard_update",
			agent: { status: "busy", elapsed: "10s" },
			queue: { p1: 1, p2: 0, p3: 0 },
			orchestrators: [{ windowId: "orch-1", scope: "Escalating: full agent analyzing auth" }],
			windows: [],
			tokens: 500,
		});

		await journey.expectText("Escalating: full agent analyzing auth");
	});

	it("orchestrator removed after escalation complete, result panel added", async () => {
		// Escalation done: orchestrator removed, result delivered via add_panel
		await journey.agentSends({
			type: "dashboard_update",
			agent: { status: "idle", elapsed: "" },
			queue: { p1: 0, p2: 0, p3: 0 },
			orchestrators: [],
			windows: [],
			tokens: 1200,
		});

		await journey.agentSends({
			type: "add_panel",
			id: "escalation-result",
			title: "Escalation Result",
			icon: "\u2714",
			path: "panels/DashboardPanel.qml", // reuse for test
		});

		// Orchestrator gone, result panel visible in sidebar
		await journey.expectText("No active orchestrators");
		await journey.expectText("Escalation Result");
	});

	it("result panel is navigable", async () => {
		// The escalation result panel should exist in the panel list
		const panelCount = await journey.evaluate<number>("root.panels.length");
		expect(panelCount).toBe(3); // chat, dashboard, escalation-result

		// Switch to it
		const idx = await journey.evaluate<number>("root.findPanelIndexById('escalation-result')");
		expect(idx).toBeGreaterThanOrEqual(0);

		await journey.evaluate(`root.activePanelIndex = ${idx}`);

		// Panel loaded successfully (not in error state)
		const loaderStatus = await journey.evaluate<number>("panelLoader.status");
		// Loader.Ready = 1
		expect(loaderStatus).toBe(1);
	});
});

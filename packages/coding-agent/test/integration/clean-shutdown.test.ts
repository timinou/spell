/**
 * PROJ-F integration test: Clean shutdown behavior.
 * Verifies the harness tears down without hanging or leaking processes
 * after a full state setup.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { isBridgeAvailable, QmlJourney } from "../helpers/qml-journey";

const SHELL_QML = "shell.qml";
const SHUTDOWN_TIMEOUT = 10_000;

describe.skipIf(!isBridgeAvailable())("Clean Shutdown", () => {
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

	// No afterAll teardown — the last test IS the teardown

	it("builds full state with panels and orchestrators", async () => {
		// Add extra panel
		await journey.agentSends({
			type: "add_panel",
			id: "extra",
			title: "Extra Panel",
			icon: "E",
			path: "panels/DashboardPanel.qml",
		});

		// Switch to dashboard
		await journey.switchPanel("dashboard");

		// Send dashboard update with orchestrators
		await journey.agentSends({
			type: "dashboard_update",
			agent: { status: "busy", elapsed: "12s" },
			queue: { p1: 5, p2: 10, p3: 2 },
			orchestrators: [{ windowId: "orch-x", scope: "Pre-shutdown scope" }],
			windows: [{ id: "canvas-1", title: "Canvas 1", state: "ready" }],
			tokens: 5000,
		});

		// Verify full state is visible
		await journey.expectText("Extra Panel");
		await journey.expectText("Pre-shutdown scope");
		await journey.expectText("Agent is busy");
	});

	it("teardown completes without hanging", async () => {
		const start = Date.now();
		await journey.teardown();
		const elapsed = Date.now() - start;

		// Teardown should complete well within the timeout
		expect(elapsed).toBeLessThan(SHUTDOWN_TIMEOUT);
	});
});

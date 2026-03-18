/**
 * PROJ-F integration test: Queue backpressure visibility in dashboard.
 * Verifies queue depth numbers update and warning colors appear at high values.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { isBridgeAvailable, QmlJourney } from "../helpers/qml-journey";

const SHELL_QML = "shell.qml";

describe.skipIf(!isBridgeAvailable())("Queue Backpressure", () => {
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
		// Switch to dashboard
		await journey.switchPanel("dashboard");
	});

	afterAll(async () => {
		await journey.teardown();
	});

	it("queue shows all zeros initially", async () => {
		await journey.agentSends({
			type: "dashboard_update",
			agent: { status: "idle", elapsed: "" },
			queue: { p1: 0, p2: 0, p3: 0 },
			orchestrators: [],
			windows: [],
			tokens: 0,
		});

		// Verify queue depth section exists
		await journey.expectText("Queue Depth");

		// Read queue values via the loaded panel item (dashboardPanel id is scoped inside the Loader)
		const p1 = await journey.panelProperty<number>("queueP1");
		const p2 = await journey.panelProperty<number>("queueP2");
		const p3 = await journey.panelProperty<number>("queueP3");
		expect(p1).toBe(0);
		expect(p2).toBe(0);
		expect(p3).toBe(0);
	});

	it("elevated queue numbers are reflected in dashboard properties", async () => {
		await journey.agentSends({
			type: "dashboard_update",
			agent: { status: "busy", elapsed: "1s" },
			queue: { p1: 15, p2: 30, p3: 5 },
			orchestrators: [],
			windows: [],
			tokens: 100,
		});

		const p1 = await journey.panelProperty<number>("queueP1");
		const p2 = await journey.panelProperty<number>("queueP2");
		const p3 = await journey.panelProperty<number>("queueP3");
		expect(p1).toBe(15);
		expect(p2).toBe(30);
		expect(p3).toBe(5);
	});

	it("high P2 queue triggers warning color", async () => {
		await journey.agentSends({
			type: "dashboard_update",
			agent: { status: "busy", elapsed: "5s" },
			queue: { p1: 0, p2: 60, p3: 0 },
			orchestrators: [],
			windows: [],
			tokens: 200,
		});

		// queueColor(60) should return error color (value > 50)
		const color = await journey.evaluate<string>("panelLoader.item.queueColor(60)");
		const errorColor = await journey.evaluate<string>("panelLoader.item.statusColor('error')");
		expect(color).toBe(errorColor);
	});

	it("queue returns to zero after backpressure clears", async () => {
		await journey.agentSends({
			type: "dashboard_update",
			agent: { status: "idle", elapsed: "" },
			queue: { p1: 0, p2: 0, p3: 0 },
			orchestrators: [],
			windows: [],
			tokens: 300,
		});

		const p1 = await journey.panelProperty<number>("queueP1");
		const p2 = await journey.panelProperty<number>("queueP2");
		const p3 = await journey.panelProperty<number>("queueP3");
		expect(p1).toBe(0);
		expect(p2).toBe(0);
		expect(p3).toBe(0);
	});
});

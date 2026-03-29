import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { isBridgeAvailable, QmlJourney } from "../../helpers/qml-journey";

describe.skipIf(!isBridgeAvailable())("LoopDashboard", () => {
	let journey: QmlJourney;

	beforeAll(async () => {
		journey = await QmlJourney.launch("LoopDashboard.qml");
	});

	afterAll(async () => {
		await journey.teardown();
	});

	it("renders loop state and emits control events", async () => {
		await journey.agentSends({
			type: "loop_snapshot",
			loop: {
				id: "LOOP-1",
				name: "Demo Loop",
				state: "planning",
				iteration: 1,
				maxIterations: 3,
				elapsedMs: 100,
				budgetLimitMs: 1000,
			},
			tree: [
				{ id: "LOOP-1", name: "Demo Loop", state: "planning" },
				{ id: "LOOP-2", name: "Child Loop", state: "paused" },
			],
			gates: [{ gateId: "gate-1", outcome: "pass", reason: "ok" }],
			pendingGateId: "gate-2",
			autoApproveEnabled: true,
			autoApproveAt: 5000,
			nowMs: 1000,
		});
		await journey.expectText("Demo Loop");
		await journey.expectText("iteration 1 / 3");
		await journey.expectText("Child Loop");
		await journey.expectText("gate-1");

		const pauseEvent = journey.waitForEvent(
			event =>
				event.type === "event" &&
				(event as { payload?: { type?: string; action?: string } }).payload?.type === "loop_control" &&
				(event as { payload?: { action?: string } }).payload?.action === "pause",
		);
		await journey.click({ type: "Button", textContains: "Pause", visible: true });
		expect((await pauseEvent) as { payload?: { action?: string } }).toHaveProperty("payload.action", "pause");

		const approveEvent = journey.waitForEvent(
			event => event.type === "event" && (event as { payload?: { action?: string } }).payload?.action === "approve",
		);
		await journey.click({ type: "Button", textContains: "Approve", visible: true });
		expect((await approveEvent) as { payload?: { gateId?: string } }).toHaveProperty("payload.gateId", "gate-2");
	});
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { SIMPLE_PLAN } from "../helpers/fluid-test-data";
import { isBridgeAvailable, QmlJourney } from "../helpers/qml-journey";

const FLUID_SHELL_QML = "FluidShell.qml";

type BridgeEvent = {
	type: "event";
	payload?: { type?: string; text?: string; reason?: string; agentIds?: string[] };
};

describe.skipIf(!isBridgeAvailable())("FluidShell States", () => {
	let journey: QmlJourney;

	beforeAll(async () => {
		journey = await QmlJourney.launch(FLUID_SHELL_QML);
		await journey.settle(100);
	});

	afterAll(async () => {
		await journey.teardown();
	});

	beforeEach(async () => {
		await journey.evaluate("root.state = 'input'");
		await journey.evaluate("root.planReady = false");
		await journey.evaluate("root.pendingAgentEvents = []");
		await journey.evaluate("root.lastError = ''");
		await journey.evaluate("root.clearAgents()");
		await journey.evaluate("root.planningStreamText = ''");
		await journey.evaluate("root.planningStartedAt = 0");
		await journey.evaluate("root.planningElapsedSeconds = 0");
		await journey.evaluate("root.showPlanningFallback = false");
		await journey.evaluate("intentField.text = ''");
		await journey.settle(50);
	});

	it("supports input submission behavior and plan button submission", async () => {
		expect(await journey.evaluate<string>("root.state")).toBe("input");
		await journey.expectText("What do you want to build?");
		expect(await journey.evaluate<boolean>("intentField.visible")).toBe(true);

		await journey.evaluate("intentField.forceActiveFocus()");
		await journey.type("build analyzer");
		const enterEventPromise = journey.waitForEvent(
			e => (e as BridgeEvent).type === "event" && (e as BridgeEvent).payload?.type === "prompt",
			5000,
		);
		await journey.press("Return");
		const enterPrompt = (await enterEventPromise) as BridgeEvent;
		expect(enterPrompt.payload?.text).toBe("build analyzer");
		expect(await journey.evaluate<string>("intentField.text")).toBe("");

		await journey.evaluate("intentField.forceActiveFocus()");
		const emptyEvent = journey
			.waitForEvent(e => (e as BridgeEvent).type === "event" && (e as BridgeEvent).payload?.type === "prompt", 200)
			.then(() => true)
			.catch(() => false);
		await journey.press("Return");
		expect(await emptyEvent).toBeFalse();

		await journey.evaluate("intentField.forceActiveFocus()");
		await journey.type("from plan button");
		const planEventPromise = journey.waitForEvent(
			e => (e as BridgeEvent).type === "event" && (e as BridgeEvent).payload?.type === "prompt",
			5000,
		);
		await journey.click({ type: "Button", textContains: "Plan", visible: true });
		const planPrompt = (await planEventPromise) as BridgeEvent;
		expect(planPrompt.payload?.text).toBe("from plan button");
		expect(await journey.evaluate<string>("intentField.text")).toBe("");
	});

	it("shows planning state and hides input state", async () => {
		await journey.agentSends({ type: "fluid:plan_start" });
		await journey.expectText("Planning...");
		expect(await journey.evaluate<string>("root.state")).toBe("planning");
		expect(await journey.evaluate<number>("stateStack.currentIndex")).toBe(1);
		expect(await journey.evaluate<boolean>("intentField.visible")).toBe(false);
	});

	it("shows planner stream content during planning", async () => {
		await journey.agentSends({ type: "fluid:plan_start" });
		await journey.agentSends({ type: "fluid:planner_stream", text: "Inspecting repo" });
		expect(await journey.evaluate<string>("root.planningStreamText")).toContain("Inspecting repo");
	});

	it("blocks prompt submission while not in input state", async () => {
		await journey.evaluate("root.state = 'planning'");
		await journey.evaluate("intentField.text = 'should-not-submit'");
		const eventSeen = journey
			.waitForEvent(e => (e as BridgeEvent).type === "event" && (e as BridgeEvent).payload?.type === "prompt", 200)
			.then(() => true)
			.catch(() => false);
		await journey.evaluate("root.submitPrompt()");
		expect(await eventSeen).toBeFalse();
	});

	it("sends cancel_execution from planning state", async () => {
		await journey.agentSends({ type: "fluid:plan_start" });
		const cancelEventPromise = journey.waitForEvent(
			e => (e as BridgeEvent).type === "event" && (e as BridgeEvent).payload?.type === "cancel_execution",
			5000,
		);
		await journey.click({ type: "Button", textContains: "Cancel", visible: true });
		const cancelEvent = (await cancelEventPromise) as BridgeEvent;
		expect(cancelEvent.payload?.reason).toBe("Cancelled during planning");
	});

	it("returns to input on execution_cancelled", async () => {
		await journey.agentSends({ type: "fluid:plan_complete", plan: SIMPLE_PLAN });
		await journey.agentSends({ type: "fluid:execution_cancelled", reason: "Cancelled by user" });
		await journey.settle(80);
		expect(await journey.evaluate<string>("root.state")).toBe("input");
		await journey.expectText("Cancelled by user");
	});

	it("recovers from plan_error and allows resubmission", async () => {
		await journey.agentSends({ type: "fluid:plan_start" });
		await journey.agentSends({ type: "fluid:plan_error", error: "Planning failed" });
		await journey.expectText("Planning failed");
		expect(await journey.evaluate<string>("root.state")).toBe("input");
		expect(await journey.evaluate<number>("stateStack.currentIndex")).toBe(0);

		await journey.evaluate("intentField.forceActiveFocus()");
		await journey.type("retry prompt");
		const retryEventPromise = journey.waitForEvent(
			e => (e as BridgeEvent).type === "event" && (e as BridgeEvent).payload?.type === "prompt",
			5000,
		);
		await journey.press("Return");
		const retryPrompt = (await retryEventPromise) as BridgeEvent;
		expect(retryPrompt.payload?.text).toBe("retry prompt");
	});

	it("enters executing state on plan_complete and complete state on execution_complete", async () => {
		await journey.agentSends({ type: "fluid:plan_complete", plan: SIMPLE_PLAN });
		await journey.settle(80);
		expect(await journey.evaluate<string>("root.state")).toBe("executing");
		expect(await journey.evaluate<number>("agentsModel.count")).toBe(2);
		await journey.expectText("0/2 agents completed");

		await journey.agentSends({ type: "fluid:agent_state_change", agentId: "analyze", state: "completed" });
		await journey.agentSends({ type: "fluid:agent_state_change", agentId: "fix", state: "completed" });
		await journey.agentSends({
			type: "fluid:execution_complete",
			results: [],
		});
		await journey.settle(80);
		expect(await journey.evaluate<string>("root.state")).toBe("complete");
		await journey.expectText("Execution complete");
		await journey.expectText("2/2 agents completed");
	});

	it("emits retry_failed with failed agent ids", async () => {
		await journey.agentSends({ type: "fluid:plan_complete", plan: SIMPLE_PLAN });
		await journey.agentSends({ type: "fluid:agent_state_change", agentId: "fix", state: "failed" });
		await journey.agentSends({ type: "fluid:execution_complete", results: [] });
		await journey.settle(80);

		const retryEventPromise = journey.waitForEvent(
			e => (e as BridgeEvent).type === "event" && (e as BridgeEvent).payload?.type === "retry_failed",
			5000,
		);
		await journey.click({ type: "Button", textContains: "Retry Failed Subtree", visible: true });
		const retryEvent = (await retryEventPromise) as BridgeEvent;
		expect(retryEvent.payload?.agentIds).toEqual(["fix"]);
	});

	it("captures completion summary values from execution results", async () => {
		await journey.agentSends({ type: "fluid:plan_complete", plan: SIMPLE_PLAN });
		await journey.agentSends({
			type: "fluid:execution_complete",
			results: [
				{ agentId: "analyze", state: "completed", startedAt: 1000, completedAt: 4000 },
				{ agentId: "fix", state: "failed", startedAt: 2000, completedAt: 5000 },
			],
		});
		await journey.settle(80);
		expect(await journey.evaluate<number>("root.executionSummary.total")).toBe(2);
		expect(await journey.evaluate<number>("root.executionSummary.completed")).toBe(1);
		expect(await journey.evaluate<number>("root.executionSummary.failed")).toBe(1);
		expect(await journey.evaluate<number>("root.executionSummary.elapsedSeconds")).toBe(4);
	});

	it("returns to input when New Prompt is clicked after completion", async () => {
		await journey.agentSends({ type: "fluid:plan_complete", plan: SIMPLE_PLAN });
		await journey.agentSends({ type: "fluid:execution_complete", results: [] });
		await journey.settle(80);
		expect(await journey.evaluate<string>("root.state")).toBe("complete");
		await journey.click({ type: "Button", textContains: "New Prompt", visible: true });
		await journey.settle(60);
		expect(await journey.evaluate<string>("root.state")).toBe("input");
		expect(await journey.evaluate<number>("agentsModel.count")).toBe(0);
	});
});

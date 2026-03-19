import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { SIMPLE_PLAN } from "../helpers/fluid-test-data";
import { isBridgeAvailable, QmlJourney } from "../helpers/qml-journey";

const FLUID_SHELL_QML = "FluidShell.qml";

describe.skipIf(!isBridgeAvailable())("FluidShell Agent Events", () => {
	let journey: QmlJourney;

	beforeAll(async () => {
		journey = await QmlJourney.launch(FLUID_SHELL_QML);
		await journey.settle(100);
	});

	afterAll(async () => {
		await journey.teardown();
	});

	beforeEach(async () => {
		await journey.agentSends({ type: "fluid:plan_complete", plan: SIMPLE_PLAN });
		await journey.settle(50);
	});

	it("updates agent state transitions and status counters", async () => {
		await journey.agentSends({ type: "fluid:agent_state_change", agentId: "analyze", state: "ready" });
		expect(await journey.evaluate<string>("agentsModel.get(0).agentState")).toBe("ready");

		await journey.agentSends({
			type: "fluid:agent_state_change",
			agentId: "analyze",
			state: "running",
			startedAt: 1_700_000_000_000,
		});
		expect(await journey.evaluate<string>("agentsModel.get(0).agentState")).toBe("running");
		expect(await journey.evaluate<number>("agentsModel.get(0).startedAt")).toBe(1_700_000_000_000);

		await journey.agentSends({
			type: "fluid:agent_state_change",
			agentId: "analyze",
			state: "completed",
			startedAt: 1_700_000_000_000,
			completedAt: 1_700_000_000_500,
		});
		expect(await journey.evaluate<string>("agentsModel.get(0).agentState")).toBe("completed");
		expect(await journey.evaluate<number>("agentsModel.get(0).completedAt")).toBe(1_700_000_000_500);

		await journey.agentSends({
			type: "fluid:agent_state_change",
			agentId: "fix",
			state: "failed",
			error: "lint failed",
		});
		expect(await journey.evaluate<string>("agentsModel.get(1).agentState")).toBe("failed");
		expect(await journey.evaluate<string>("agentsModel.get(1).agentError")).toBe("lint failed");

		expect(await journey.evaluate<number>("root.completedCount")).toBe(1);
		expect(await journey.evaluate<number>("root.failedCount")).toBe(1);
		expect(await journey.evaluate<number>("root.totalCount")).toBe(2);
		await journey.expectText("1/2 agents completed");
	});

	it("updates dependency status as upstream agents complete", async () => {
		expect(await journey.evaluate<string>("agentsModel.get(1).dependencyStatus")).toBe("Dependencies: 0/1 complete");
		await journey.agentSends({ type: "fluid:agent_state_change", agentId: "analyze", state: "completed" });
		expect(await journey.evaluate<string>("agentsModel.get(1).dependencyStatus")).toBe("Dependencies: satisfied");
	});

	it("concatenates stream events in arrival order", async () => {
		await journey.agentSends({ type: "fluid:agent_stream", agentId: "analyze", text: "hello" });
		await journey.agentSends({ type: "fluid:agent_stream", agentId: "analyze", text: " world" });

		expect(await journey.evaluate<string>("agentsModel.get(0).streamText")).toBe("hello world");
		const helloIndex = await journey.evaluate<number>('agentsModel.get(0).streamText.indexOf("hello")');
		const worldIndex = await journey.evaluate<number>('agentsModel.get(0).streamText.indexOf(" world")');
		expect(helloIndex).toBeGreaterThanOrEqual(0);
		expect(worldIndex).toBeGreaterThan(helloIndex);
	});

	it("attaches canvas output payload to the matching agent model row", async () => {
		await journey.agentSends({
			type: "fluid:canvas_output",
			agentId: "analyze",
			outputType: "markdown",
			title: "Result",
			content: "# Hello",
		});

		await journey.waitUntil(async () => {
			const outputType = await journey.evaluate<string>(
				"				(agentsModel.get(0).canvasOutput && agentsModel.get(0).canvasOutput.blockType) || ''",
			);
			return outputType === "markdown" ? outputType : null;
		}, 2000);

		expect(
			await journey.evaluate<string>(
				"				(agentsModel.get(0).canvasOutput && agentsModel.get(0).canvasOutput.blockType) || ''",
			),
		).toBe("markdown");
		expect(
			await journey.evaluate<string>(
				"				(agentsModel.get(0).canvasOutput && agentsModel.get(0).canvasOutput.title) || ''",
			),
		).toBe("Result");
		expect(
			await journey.evaluate<string>(
				"				(agentsModel.get(0).canvasOutput && agentsModel.get(0).canvasOutput.blockData && agentsModel.get(0).canvasOutput.blockData.text) || ''",
			),
		).toBe("# Hello");
	});

	it("preserves canvas output payload fields through queued event flush", async () => {
		await journey.agentSends({ type: "fluid:plan_start" });
		await journey.agentSends({
			type: "fluid:canvas_output",
			agentId: "fix",
			outputType: "markdown",
			title: "Fix Summary",
			content: "Patched 3 files",
		});

		expect(await journey.evaluate<number>("root.pendingAgentEvents.length")).toBe(1);
		expect(await journey.evaluate<string>("root.pendingAgentEvents[0].type")).toBe("fluid:canvas_output");
		expect(await journey.evaluate<string>("root.pendingAgentEvents[0].agentId")).toBe("fix");
		expect(await journey.evaluate<string>("root.pendingAgentEvents[0].outputType")).toBe("markdown");
		expect(await journey.evaluate<string>("root.pendingAgentEvents[0].title")).toBe("Fix Summary");
		expect(await journey.evaluate<string>("root.pendingAgentEvents[0].content")).toBe("Patched 3 files");

		await journey.agentSends({ type: "fluid:plan_complete", plan: SIMPLE_PLAN });
		expect(await journey.evaluate<number>("root.pendingAgentEvents.length")).toBe(0);
	});

	it("queues agent events before plan and flushes them in order on plan_complete", async () => {
		await journey.agentSends({ type: "fluid:plan_start" });
		await journey.agentSends({ type: "fluid:agent_stream", agentId: "analyze", text: "queued-1" });
		await journey.agentSends({ type: "fluid:agent_stream", agentId: "analyze", text: " queued-2" });
		await journey.agentSends({ type: "fluid:agent_state_change", agentId: "analyze", state: "running" });

		expect(await journey.evaluate<number>("root.pendingAgentEvents.length")).toBe(3);
		expect(await journey.evaluate<string>("root.state")).toBe("planning");

		await journey.agentSends({ type: "fluid:plan_complete", plan: SIMPLE_PLAN });
		await journey.settle(80);

		expect(await journey.evaluate<number>("root.pendingAgentEvents.length")).toBe(0);
		expect(await journey.evaluate<string>("agentsModel.get(0).agentState")).toBe("running");
		expect(await journey.evaluate<string>("agentsModel.get(0).streamText")).toBe("queued-1 queued-2");
		const queued1Index = await journey.evaluate<number>('agentsModel.get(0).streamText.indexOf("queued-1")');
		const queued2Index = await journey.evaluate<number>('agentsModel.get(0).streamText.indexOf("queued-2")');
		expect(queued2Index).toBeGreaterThan(queued1Index);
	});
});

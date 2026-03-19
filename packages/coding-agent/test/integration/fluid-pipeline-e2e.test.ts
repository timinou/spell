import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { FLUID_EVENT_CHANNEL, FluidOrchestrator, type FluidPlan } from "../../src/orchestrators/fluid";
import { Priority } from "../../src/utils/event-bus";
import { PARALLEL_PLAN, SIMPLE_PLAN, mockResult } from "../helpers/fluid-test-data";
import { type FluidPipeline, setupFluidPipeline } from "../helpers/fluid-pipeline";
import { isBridgeAvailable } from "../helpers/qml-journey";

interface ShellBridgeEvent {
	type?: string;
	payload?: {
		type?: string;
		reason?: string;
		text?: string;
		agentIds?: string[];
	};
}

function buildAgentStateExpression(agentId: string): string {
	return `(function () {
		for (var i = 0; i < agentsModel.count; i++) {
			var row = agentsModel.get(i);
			if (String(row.agentId) === ${JSON.stringify(agentId)}) {
				return String(row.agentState || "");
			}
		}
		return "";
	})()`;
}

async function waitForState(pipeline: FluidPipeline, state: string, timeout = 5000): Promise<void> {
	await pipeline.journey.waitUntil(async () => {
		const currentState = await pipeline.journey.evaluate<string>("root.state");
		return currentState === state ? currentState : null;
	}, timeout);
}

async function resetFluidShellState(pipeline: FluidPipeline): Promise<void> {
	await pipeline.journey.evaluate("root.resetToInput()");
	await pipeline.journey.evaluate("intentField.text = ''");
	await pipeline.journey.settle(80);
}

async function flushEventBus(pipeline: FluidPipeline): Promise<void> {
	while ((await pipeline.eventBus.drain()) > 0) {
		// EventBus.drain() is bounded per call; loop until empty.
	}
}

function createOrchestrator(pipeline: FluidPipeline, plan: FluidPlan): FluidOrchestrator {
	const delayById: Record<string, number> = {
		root: 120,
		"branch-a": 260,
		"branch-b": 180,
		merge: 140,
		analyze: 240,
		fix: 240,
	};
	return new FluidOrchestrator({
		eventBus: pipeline.eventBus,
		cwd: process.cwd(),
		concurrency: 2,
		runAgent: async (node, _upstreamResults, _signal) => {
			await Bun.sleep(delayById[node.id] ?? 10);
			const output = `${node.id}:${plan.agents.length}`;
			return mockResult(node.id, output);
		},
	});
}

describe.skipIf(!isBridgeAvailable())("Fluid pipeline end-to-end", () => {
	let pipeline: FluidPipeline;

	beforeAll(async () => {
		pipeline = await setupFluidPipeline();
		await resetFluidShellState(pipeline);
	});

	beforeEach(async () => {
		await pipeline.stopDrain();
		await resetFluidShellState(pipeline);
	});

	afterEach(async () => {
		await pipeline.stopDrain();
		await flushEventBus(pipeline);
	});

	afterAll(async () => {
		await pipeline.teardown();
	});

	test("planning and execution events reach QML through the real pipeline", async () => {
		pipeline.startDrain();

		pipeline.eventBus.enqueue(FLUID_EVENT_CHANNEL, { type: "plan_start" }, Priority.P1);
		await waitForState(pipeline, "planning");

		pipeline.eventBus.enqueue(
			FLUID_EVENT_CHANNEL,
			{ type: "planner_stream", text: "stream text" },
			Priority.P2,
			"stream:planner",
		);
		await pipeline.journey.waitUntil(async () => {
			const planningText = await pipeline.journey.evaluate<string>("root.planningStreamText");
			return planningText.includes("stream text") ? planningText : null;
		}, 5000);

		await pipeline.stopDrain();

		const orchestrator = createOrchestrator(pipeline, SIMPLE_PLAN);
		const executionPromise = orchestrator.execute(SIMPLE_PLAN);

		await waitForState(pipeline, "executing");
		const results = await executionPromise;
		await flushEventBus(pipeline);
		await waitForState(pipeline, "complete");

		expect(results.size).toBe(SIMPLE_PLAN.agents.length);
		expect(await pipeline.journey.evaluate<number>("root.completedCount")).toBe(SIMPLE_PLAN.agents.length);
		await pipeline.journey.expectText("Execution complete");
	}, 15000);

	test("cancel during planning round-trips from QML to EventBus and back", async () => {
		pipeline.startDrain();
		pipeline.eventBus.enqueue(FLUID_EVENT_CHANNEL, { type: "plan_start" }, Priority.P1);
		await waitForState(pipeline, "planning");

		const cancelEventPromise = pipeline.journey.waitForEvent(event => {
			const bridgeEvent = event as unknown as ShellBridgeEvent;
			return bridgeEvent.type === "event" && bridgeEvent.payload?.type === "cancel_execution";
		}, 5000);
		await pipeline.journey.click({ type: "Button", textContains: "Cancel", visible: true });

		const cancelEvent = (await cancelEventPromise) as unknown as ShellBridgeEvent;
		expect(cancelEvent.payload?.type).toBe("cancel_execution");
		expect(cancelEvent.payload?.reason).toBe("Cancelled during planning");

		pipeline.eventBus.enqueue(
			FLUID_EVENT_CHANNEL,
			{ type: "execution_cancelled", reason: cancelEvent.payload?.reason ?? "Cancelled during planning" },
			Priority.P1,
		);

		await waitForState(pipeline, "input");
		await pipeline.journey.expectText("Cancelled");
	}, 10000);

	test("rapid planner stream events coalesce end-to-end", async () => {
		pipeline.startDrain();
		pipeline.eventBus.enqueue(FLUID_EVENT_CHANNEL, { type: "plan_start" }, Priority.P1);
		await waitForState(pipeline, "planning");

		for (let idx = 1; idx <= 20; idx++) {
			pipeline.eventBus.enqueue(
				FLUID_EVENT_CHANNEL,
				{ type: "planner_stream", text: `intent-${idx}` },
				Priority.P2,
				"stream:planner",
			);
		}

		const finalText = "intent-20";
		const renderedPlanningText = await pipeline.journey.waitUntil(async () => {
			const planningText = await pipeline.journey.evaluate<string>("root.planningStreamText");
			return planningText.includes(finalText) ? planningText : null;
		}, 5000);

		expect(renderedPlanningText.trimEnd().endsWith(finalText)).toBeTrue();
		expect(renderedPlanningText.split("\n").filter(Boolean).length).toBeLessThan(20);
	}, 10000);

	test("parallel orchestrator execution drives QML agent panels through the real pipeline", async () => {
		pipeline.startDrain();
		pipeline.eventBus.enqueue(FLUID_EVENT_CHANNEL, { type: "plan_start" }, Priority.P1);
		await waitForState(pipeline, "planning");

		await pipeline.stopDrain();

		const orchestrator = createOrchestrator(pipeline, PARALLEL_PLAN);
		const executionPromise = orchestrator.execute(PARALLEL_PLAN);

		await waitForState(pipeline, "executing");
		await executionPromise;
		await flushEventBus(pipeline);
		await waitForState(pipeline, "complete");

		for (const agent of PARALLEL_PLAN.agents) {
			await pipeline.journey.waitUntil(async () => {
				const state = await pipeline.journey.evaluate<string>(buildAgentStateExpression(agent.id));
				return state === "completed" ? state : null;
			}, 5000);
		}

		expect(await pipeline.journey.evaluate<number>("root.completedCount")).toBe(PARALLEL_PLAN.agents.length);
		expect(await pipeline.journey.evaluate<number>("root.totalCount")).toBe(PARALLEL_PLAN.agents.length);
	}, 15000);
});

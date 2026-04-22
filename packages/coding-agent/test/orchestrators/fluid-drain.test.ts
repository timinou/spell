import { describe, expect, test } from "bun:test";
import {
	type AgentRuntime,
	FLUID_EVENT_CHANNEL,
	type FluidEvent,
	FluidEventRouter,
	type FluidPlan,
} from "../../src/orchestrators/fluid";
import type { SingleResult } from "../../src/task/types";
import { EventBus } from "../../src/utils/event-bus";

function mockResult(id: string, output = ""): SingleResult {
	return {
		index: 0,
		id,
		agent: "test",
		agentSource: "bundled",
		task: "test",
		exitCode: 0,
		outcome: "completed",
		stderr: "",
		resultUri: `agent://${id}`,
		textPreview: output,
		durationMs: 100,
		tokens: 10,
	};
}

describe("FluidEventRouter", () => {
	test("routes events to bridge:outbound", async () => {
		const eventBus = new EventBus();
		new FluidEventRouter(eventBus);

		const outbound: unknown[] = [];
		eventBus.subscribe("bridge:outbound", payload => {
			outbound.push(payload);
		});

		eventBus.emit(FLUID_EVENT_CHANNEL, { type: "plan_start" } satisfies FluidEvent);
		await eventBus.drain();

		expect(outbound).toHaveLength(1);
		expect(outbound[0]).toEqual({ type: "fluid:plan_start" });
	});

	test("dispose stops routing", async () => {
		const eventBus = new EventBus();
		const router = new FluidEventRouter(eventBus);
		router.dispose();

		const outbound: unknown[] = [];
		eventBus.subscribe("bridge:outbound", payload => {
			outbound.push(payload);
		});

		eventBus.emit(FLUID_EVENT_CHANNEL, { type: "plan_start" } satisfies FluidEvent);
		await eventBus.drain();

		expect(outbound).toHaveLength(0);
	});

	test("toBridgePayload maps all event types", () => {
		const eventBus = new EventBus();
		const router = new FluidEventRouter(eventBus);

		const plan: FluidPlan = {
			agents: [{ id: "a", task: "task", dependsOn: [] }],
		};
		const runtime: AgentRuntime = {
			node: plan.agents[0],
			state: "completed",
			result: mockResult("a", "done"),
		};

		const events: FluidEvent[] = [
			{ type: "plan_start" },
			{ type: "plan_complete", plan },
			{ type: "plan_error", error: "bad plan" },
			{
				type: "agent_state_change",
				agentId: "a",
				state: "completed",
				result: mockResult("a"),
				error: undefined,
				startedAt: undefined,
				completedAt: undefined,
			},
			{ type: "planner_stream", text: "thinking" },
			{ type: "agent_stream", agentId: "a", text: "hello" },
			{ type: "canvas_output", agentId: "a", outputType: "markdown", title: "out", content: "body" },
			{ type: "execution_cancelled", reason: "user cancelled" },
			{ type: "execution_complete", results: new Map([["a", runtime]]) },
		];

		const mapped = events.map(event => router.toBridgePayload(event));
		expect(mapped).toEqual([
			{ type: "fluid:plan_start" },
			{ type: "fluid:plan_complete", plan },
			{ type: "fluid:plan_error", error: "bad plan" },
			{
				type: "fluid:agent_state_change",
				agentId: "a",
				state: "completed",
				result: mockResult("a"),
				error: undefined,
				startedAt: undefined,
				completedAt: undefined,
			},
			{ type: "fluid:planner_stream", text: "thinking" },
			{ type: "fluid:agent_stream", agentId: "a", text: "hello" },
			{
				type: "fluid:canvas_output",
				agentId: "a",
				outputType: "markdown",
				title: "out",
				content: "body",
			},
			{ type: "fluid:execution_cancelled", reason: "user cancelled" },
			{
				type: "fluid:execution_complete",
				results: [
					{
						agentId: "a",
						state: "completed",
						error: undefined,
						result: mockResult("a", "done"),
						startedAt: undefined,
						completedAt: undefined,
					},
				],
			},
		]);

		router.dispose();
	});
});

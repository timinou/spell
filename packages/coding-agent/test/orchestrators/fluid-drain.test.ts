import { describe, expect, test } from "bun:test";
import {
	type AgentRuntime,
	FLUID_EVENT_CHANNEL,
	type FluidEvent,
	FluidEventRouter,
	FluidOrchestrator,
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
		output,
		stderr: "",
		truncated: false,
		durationMs: 100,
		tokens: 10,
	};
}

describe("FluidOrchestrator drain behavior", () => {
	test("events reach event bus during execution", async () => {
		const eventBus = new EventBus();
		const received: FluidEvent[] = [];
		eventBus.subscribe(FLUID_EVENT_CHANNEL, data => {
			received.push(data as FluidEvent);
		});

		const orchestrator = new FluidOrchestrator({
			eventBus,
			cwd: process.cwd(),
			runAgent: async (node, _upstreamResults, _signal) => mockResult(node.id, `done:${node.id}`),
		});

		const plan: FluidPlan = {
			agents: [
				{ id: "a", task: "first", dependsOn: [] },
				{ id: "b", task: "second", dependsOn: ["a"] },
			],
		};

		await orchestrator.execute(plan);
		await eventBus.drain();

		expect(received.some(event => event.type === "plan_start")).toBe(false);
		expect(received.some(event => event.type === "plan_complete")).toBe(true);
		expect(
			received.some(
				event => event.type === "agent_state_change" && event.agentId === "a" && event.state === "completed",
			),
		).toBe(true);
		expect(
			received.some(
				event => event.type === "agent_state_change" && event.agentId === "b" && event.state === "completed",
			),
		).toBe(true);
	});

	test("drain timer fires during execution", async () => {
		const eventBus = new EventBus();
		const received: FluidEvent[] = [];
		eventBus.subscribe(FLUID_EVENT_CHANNEL, data => {
			received.push(data as FluidEvent);
		});

		const orchestrator = new FluidOrchestrator({
			eventBus,
			cwd: process.cwd(),
			runAgent: async (node, _upstreamResults, _signal) => {
				await Bun.sleep(220);
				return mockResult(node.id, "slow");
			},
		});

		const plan: FluidPlan = {
			agents: [{ id: "a", task: "slow", dependsOn: [] }],
		};

		const execution = orchestrator.execute(plan);
		await Bun.sleep(140);

		expect(received.length).toBeGreaterThan(0);
		expect(
			received.some(
				event => event.type === "agent_state_change" && event.agentId === "a" && event.state === "running",
			),
		).toBe(true);

		await execution;
	});

	test("invalid DAG throws", async () => {
		const eventBus = new EventBus();
		const orchestrator = new FluidOrchestrator({
			eventBus,
			cwd: process.cwd(),
			runAgent: async (node, _upstreamResults, _signal) => mockResult(node.id),
		});

		const cyclicPlan: FluidPlan = {
			agents: [
				{ id: "entry", task: "entry", dependsOn: [] },
				{ id: "b", task: "b", dependsOn: ["c"] },
				{ id: "c", task: "c", dependsOn: ["b"] },
			],
		};

		await expect(orchestrator.execute(cyclicPlan)).rejects.toThrow("Plan contains dependency cycles");
	});

	test("abort during execution rejects", async () => {
		const eventBus = new EventBus();
		const controller = new AbortController();
		let started = false;

		const orchestrator = new FluidOrchestrator({
			eventBus,
			cwd: process.cwd(),
			runAgent: async (node, _upstreamResults, _signal) => {
				if (!started) {
					started = true;
					controller.abort();
				}
				await Bun.sleep(120);
				return mockResult(node.id);
			},
		});

		const plan: FluidPlan = {
			agents: [
				{ id: "a", task: "first", dependsOn: [] },
				{ id: "b", task: "second", dependsOn: ["a"] },
			],
		};

		await expect(orchestrator.execute(plan, controller.signal)).rejects.toThrow("Fluid execution aborted");
	});
});

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

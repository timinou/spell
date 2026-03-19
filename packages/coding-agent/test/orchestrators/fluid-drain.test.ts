import { afterEach, describe, expect, test, vi } from "bun:test";
import {
	type AgentRuntime,
	FLUID_EVENT_CHANNEL,
	type FluidEvent,
	FluidEventRouter,
	FluidOrchestrator,
	type FluidPlan,
} from "../../src/orchestrators/fluid";
import type { SingleResult } from "../../src/task/types";
import { EventBus, Priority } from "../../src/utils/event-bus";

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

interface PlanningDrainLoop {
	stop(): Promise<void>;
}

function startPlanningDrainLoop(eventBus: EventBus): PlanningDrainLoop {
	let draining = false;
	let timer: NodeJS.Timeout | undefined;
	const drainEventBusOnce = async (): Promise<number> => {
		if (draining) {
			return 0;
		}
		draining = true;
		try {
			return await eventBus.drain();
		} finally {
			draining = false;
		}
	};
	const flushEventBus = async (): Promise<void> => {
		while (draining) {
			await Bun.sleep(5);
		}
		while ((await drainEventBusOnce()) > 0) {
			// EventBus.drain() is bounded per call; loop until empty.
		}
	};
	timer = setInterval(() => {
		void drainEventBusOnce();
	}, 100);
	return {
		async stop(): Promise<void> {
			if (timer) {
				clearInterval(timer);
				timer = undefined;
			}
			await flushEventBus();
		},
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	return value as Record<string, unknown>;
}

afterEach(() => {
	vi.restoreAllMocks();
});

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

describe("executePlan planning-phase drain behavior", () => {
	test("delivers plan start and intermediate planner stream events incrementally", async () => {
		const eventBus = new EventBus();
		new FluidEventRouter(eventBus);

		const observed: Array<{ atMs: number; payload: Record<string, unknown> }> = [];
		const startedAt = Date.now();
		eventBus.subscribe("bridge:outbound", payload => {
			observed.push({ atMs: Date.now() - startedAt, payload: asRecord(payload) });
		});

		const drainLoop = startPlanningDrainLoop(eventBus);
		try {
			eventBus.enqueue(FLUID_EVENT_CHANNEL, { type: "plan_start" }, Priority.P1);
			await Bun.sleep(150);
			eventBus.enqueue(
				FLUID_EVENT_CHANNEL,
				{ type: "planner_stream", text: "intent-1" },
				Priority.P2,
				"stream:planner",
			);
			await Bun.sleep(150);
			eventBus.enqueue(
				FLUID_EVENT_CHANNEL,
				{ type: "planner_stream", text: "intent-2" },
				Priority.P2,
				"stream:planner",
			);
			await Bun.sleep(150);
		} finally {
			await drainLoop.stop();
		}

		const planStart = observed.find(event => event.payload.type === "fluid:plan_start");
		expect(planStart).toBeDefined();
		expect(planStart?.atMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(240);

		const plannerTexts = observed
			.filter(event => event.payload.type === "fluid:planner_stream")
			.map(event => event.payload.text);
		expect(plannerTexts).toEqual(["intent-1", "intent-2"]);
	});

	test("abort path clears planning drain timer without leaking active drains", async () => {
		const eventBus = new EventBus();
		new FluidEventRouter(eventBus);

		const outbound: Record<string, unknown>[] = [];
		eventBus.subscribe("bridge:outbound", payload => {
			outbound.push(asRecord(payload));
		});

		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
		const clearCallsBefore = clearIntervalSpy.mock.calls.length;
		const drainSpy = vi.spyOn(eventBus, "drain");
		const controller = new AbortController();
		controller.abort("user cancelled");

		const drainLoop = startPlanningDrainLoop(eventBus);
		let aborted = false;
		try {
			eventBus.enqueue(FLUID_EVENT_CHANNEL, { type: "plan_start" }, Priority.P1);
			if (controller.signal.aborted) {
				aborted = true;
				eventBus.enqueue(
					FLUID_EVENT_CHANNEL,
					{ type: "execution_cancelled", reason: String(controller.signal.reason ?? "Execution cancelled") },
					Priority.P1,
				);
			}
		} finally {
			await drainLoop.stop();
		}

		expect(aborted).toBe(true);
		expect(clearIntervalSpy.mock.calls.length).toBe(clearCallsBefore + 1);
		const drainCallsAfterStop = drainSpy.mock.calls.length;
		await Bun.sleep(220);
		expect(drainSpy.mock.calls.length).toBe(drainCallsAfterStop);
		expect(outbound.some(payload => payload.type === "fluid:execution_cancelled")).toBe(true);
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

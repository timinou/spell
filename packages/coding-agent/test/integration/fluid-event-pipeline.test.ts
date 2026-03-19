import { describe, expect, test } from "bun:test";
import {
	type AgentRuntime,
	FLUID_EVENT_CHANNEL,
	type FluidEvent,
	FluidEventRouter,
	FluidOrchestrator,
} from "../../src/orchestrators/fluid";
import { EventBus } from "../../src/utils/event-bus";
import { CANVAS_OUTPUT_PLAN, mockResult, PARALLEL_PLAN } from "../helpers/fluid-test-data";

function asRecord(value: unknown): Record<string, unknown> {
	return value as Record<string, unknown>;
}

describe("FluidEventRouter payload mapping", () => {
	test("maps plan_start to fluid:plan_start", async () => {
		const eventBus = new EventBus();
		new FluidEventRouter(eventBus);

		const outbound: Record<string, unknown>[] = [];
		eventBus.subscribe("bridge:outbound", payload => {
			outbound.push(asRecord(payload));
		});

		eventBus.emit(FLUID_EVENT_CHANNEL, { type: "plan_start" } satisfies FluidEvent);
		await eventBus.drain();

		expect(outbound).toEqual([{ type: "fluid:plan_start" }]);
	});

	test("maps agent_state_change payload", async () => {
		const eventBus = new EventBus();
		new FluidEventRouter(eventBus);

		const outbound: Record<string, unknown>[] = [];
		eventBus.subscribe("bridge:outbound", payload => {
			outbound.push(asRecord(payload));
		});

		const result = mockResult("agent-a", "done");
		eventBus.emit(FLUID_EVENT_CHANNEL, {
			type: "agent_state_change",
			agentId: "agent-a",
			state: "completed",
			result,
		} satisfies FluidEvent);
		await eventBus.drain();

		expect(outbound).toEqual([
			{
				type: "fluid:agent_state_change",
				agentId: "agent-a",
				state: "completed",
				result,
				error: undefined,
				startedAt: undefined,
				completedAt: undefined,
			},
		]);
	});

	test("maps planner_stream payload", async () => {
		const eventBus = new EventBus();
		new FluidEventRouter(eventBus);

		const outbound: Record<string, unknown>[] = [];
		eventBus.subscribe("bridge:outbound", payload => {
			outbound.push(asRecord(payload));
		});

		eventBus.emit(FLUID_EVENT_CHANNEL, { type: "planner_stream", text: "thinking" } satisfies FluidEvent);
		await eventBus.drain();

		expect(outbound).toEqual([{ type: "fluid:planner_stream", text: "thinking" }]);
	});

	test("maps execution_cancelled payload", async () => {
		const eventBus = new EventBus();
		new FluidEventRouter(eventBus);

		const outbound: Record<string, unknown>[] = [];
		eventBus.subscribe("bridge:outbound", payload => {
			outbound.push(asRecord(payload));
		});

		eventBus.emit(FLUID_EVENT_CHANNEL, {
			type: "execution_cancelled",
			reason: "user cancelled",
		} satisfies FluidEvent);
		await eventBus.drain();

		expect(outbound).toEqual([{ type: "fluid:execution_cancelled", reason: "user cancelled" }]);
	});

	test("maps canvas_output while preserving fields", async () => {
		const eventBus = new EventBus();
		new FluidEventRouter(eventBus);

		const outbound: Record<string, unknown>[] = [];
		eventBus.subscribe("bridge:outbound", payload => {
			outbound.push(asRecord(payload));
		});

		eventBus.emit(FLUID_EVENT_CHANNEL, {
			type: "canvas_output",
			agentId: "dashboard",
			outputType: "table",
			title: "Metrics",
			content: "| k | v |",
		} satisfies FluidEvent);
		await eventBus.drain();

		expect(outbound).toEqual([
			{
				type: "fluid:canvas_output",
				agentId: "dashboard",
				outputType: "table",
				title: "Metrics",
				content: "| k | v |",
			},
		]);
	});

	test("serializes execution_complete result map into array entries", async () => {
		const eventBus = new EventBus();
		new FluidEventRouter(eventBus);

		const outbound: Record<string, unknown>[] = [];
		eventBus.subscribe("bridge:outbound", payload => {
			outbound.push(asRecord(payload));
		});

		const runtimeA: AgentRuntime = {
			node: PARALLEL_PLAN.agents[0],
			state: "completed",
			result: mockResult("root", "root output"),
		};
		const runtimeB: AgentRuntime = {
			node: PARALLEL_PLAN.agents[1],
			state: "failed",
			error: "boom",
		};

		eventBus.emit(FLUID_EVENT_CHANNEL, {
			type: "execution_complete",
			results: new Map([
				["root", runtimeA],
				["branch-a", runtimeB],
			]),
		} satisfies FluidEvent);
		await eventBus.drain();

		expect(outbound).toEqual([
			{
				type: "fluid:execution_complete",
				results: [
					{
						agentId: "root",
						state: "completed",
						error: undefined,
						result: runtimeA.result,
						startedAt: undefined,
						completedAt: undefined,
					},
					{
						agentId: "branch-a",
						state: "failed",
						error: "boom",
						result: undefined,
						startedAt: undefined,
						completedAt: undefined,
					},
				],
			},
		]);
	});

	test("dispose stops forwarding to bridge:outbound", async () => {
		const eventBus = new EventBus();
		const router = new FluidEventRouter(eventBus);
		router.dispose();

		const outbound: Record<string, unknown>[] = [];
		eventBus.subscribe("bridge:outbound", payload => {
			outbound.push(asRecord(payload));
		});

		eventBus.emit(FLUID_EVENT_CHANNEL, { type: "plan_start" } satisfies FluidEvent);
		await eventBus.drain();

		expect(outbound).toHaveLength(0);
	});
});

describe("FluidOrchestrator + router event pipeline", () => {
	test("parallel plan emits bridge events with required ordering invariants", async () => {
		const eventBus = new EventBus();
		const router = new FluidEventRouter(eventBus);

		const outbound: Record<string, unknown>[] = [];
		eventBus.subscribe("bridge:outbound", payload => {
			outbound.push(asRecord(payload));
		});

		const orchestrator = new FluidOrchestrator({
			eventBus,
			cwd: process.cwd(),
			concurrency: 2,
			runAgent: async (node, _upstreamResults, _signal) => {
				const delayById: Record<string, number> = {
					root: 5,
					"branch-a": 30,
					"branch-b": 10,
					merge: 5,
				};
				await Bun.sleep(delayById[node.id] ?? 0);
				return mockResult(node.id, `out:${node.id}`);
			},
		});

		await orchestrator.execute(PARALLEL_PLAN);
		await eventBus.drain();
		router.dispose();

		expect(outbound.length).toBeGreaterThan(0);
		const types = outbound.map(event => event.type);
		const planCompleteIndex = types.indexOf("fluid:plan_complete");
		const firstAgentIndex = types.indexOf("fluid:agent_state_change");
		const executionCompleteIndex = types.indexOf("fluid:execution_complete");

		expect(types.includes("fluid:plan_start")).toBe(false);
		expect(planCompleteIndex).toBeGreaterThanOrEqual(0);
		expect(firstAgentIndex).toBeGreaterThan(planCompleteIndex);
		expect(executionCompleteIndex).toBe(types.length - 1);

		for (const agent of PARALLEL_PLAN.agents) {
			const stateSequence = outbound
				.filter(event => event.type === "fluid:agent_state_change" && event.agentId === agent.id)
				.map(event => event.state);
			expect(stateSequence).toEqual(["ready", "running", "completed"]);
		}
	});

	test("canvas_output is emitted before execution_complete with plan metadata and result content", async () => {
		const eventBus = new EventBus();
		const router = new FluidEventRouter(eventBus);

		const outbound: Record<string, unknown>[] = [];
		eventBus.subscribe("bridge:outbound", payload => {
			outbound.push(asRecord(payload));
		});

		const orchestrator = new FluidOrchestrator({
			eventBus,
			cwd: process.cwd(),
			runAgent: async (node, _upstreamResults, _signal) => mockResult(node.id, `canvas:${node.id}`),
		});

		await orchestrator.execute(CANVAS_OUTPUT_PLAN);
		await eventBus.drain();
		router.dispose();

		const types = outbound.map(event => event.type);
		const firstCanvasIndex = types.indexOf("fluid:canvas_output");
		const executionCompleteIndex = types.indexOf("fluid:execution_complete");
		expect(firstCanvasIndex).toBeGreaterThan(-1);
		expect(executionCompleteIndex).toBeGreaterThan(firstCanvasIndex);

		const canvasEvents = outbound.filter(event => event.type === "fluid:canvas_output");
		expect(canvasEvents).toHaveLength(2);

		for (const agent of CANVAS_OUTPUT_PLAN.agents.filter(node => node.canvasOutput)) {
			const canvasEvent = canvasEvents.find(event => event.agentId === agent.id);
			expect(canvasEvent).toBeDefined();
			expect(canvasEvent).toMatchObject({
				type: "fluid:canvas_output",
				agentId: agent.id,
				outputType: agent.canvasOutput!.type,
				title: agent.canvasOutput!.title,
				content: `canvas:${agent.id}`,
			});
		}
	});
});

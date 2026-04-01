import { describe, expect, test } from "bun:test";
import {
	type AgentRuntime,
	FLUID_EVENT_CHANNEL,
	type FluidEvent,
	FluidEventRouter,
} from "../../src/orchestrators/fluid";
import { EventBus } from "../../src/utils/event-bus";
import { mockResult, PARALLEL_PLAN } from "../helpers/fluid-test-data";

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

	test("maps code canvas_output into structured highlighted payload", async () => {
		const eventBus = new EventBus();
		new FluidEventRouter(eventBus);

		const outbound: Record<string, unknown>[] = [];
		eventBus.subscribe("bridge:outbound", payload => {
			outbound.push(asRecord(payload));
		});

		eventBus.emit(FLUID_EVENT_CHANNEL, {
			type: "canvas_output",
			agentId: "analyze-types",
			outputType: "code",
			title: "Type map",
			content: "```ts\nconst value = 1;\n```",
		} satisfies FluidEvent);
		await eventBus.drain();

		expect(outbound).toHaveLength(1);
		const payload = outbound[0];
		expect(payload.type).toBe("fluid:canvas_output");
		expect(payload.agentId).toBe("analyze-types");
		expect(payload.outputType).toBe("code");
		expect(payload.title).toBe("Type map");
		expect(payload.content).toMatchObject({
			language: "ts",
			code: "const value = 1;",
		});
		const html = asRecord(payload.content).html;
		expect(typeof html).toBe("string");
		if (html !== "") {
			expect(html).toContain("<pre");
		}
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

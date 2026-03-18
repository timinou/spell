import { describe, expect, test } from "bun:test";
import { QueueScheduler, type RunAgentFn } from "@oh-my-pi/pi-coding-agent/orchestrators/fluid/queue-scheduler";
import type { FluidAgentNode, FluidEvent, FluidPlan } from "@oh-my-pi/pi-coding-agent/orchestrators/fluid/types";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";

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

function createMockRunner(results: Map<string, SingleResult>, delays?: Map<string, number>): RunAgentFn {
	return async node => {
		const delay = delays?.get(node.id) ?? 0;
		if (delay > 0) {
			await Bun.sleep(delay);
		}
		const result = results.get(node.id);
		if (!result) {
			throw new Error(`No mock result for ${node.id}`);
		}
		return result;
	};
}

function createFailingRunner(failIds: Set<string>): RunAgentFn {
	return async node => {
		if (failIds.has(node.id)) {
			throw new Error(`Agent ${node.id} failed`);
		}
		return mockResult(node.id);
	};
}

function makeNode(id: string, dependsOn: string[] = []): FluidAgentNode {
	return { id, task: `task-${id}`, dependsOn };
}

function makePlan(agents: FluidAgentNode[]): FluidPlan {
	return { agents };
}

describe("QueueScheduler.execute", () => {
	test("resolves immediately for an empty plan", async () => {
		const scheduler = new QueueScheduler({
			concurrency: 2,
			runAgent: createMockRunner(new Map()),
		});

		const results = await scheduler.execute(makePlan([]));
		expect(results.size).toBe(0);
	});

	test("completes a single agent", async () => {
		const plan = makePlan([makeNode("A")]);
		const scheduler = new QueueScheduler({
			concurrency: 2,
			runAgent: createMockRunner(new Map([["A", mockResult("A", "done")]])),
		});

		const results = await scheduler.execute(plan);
		const runtime = results.get("A");
		expect(runtime?.state).toBe("completed");
		expect(runtime?.result?.output).toBe("done");
	});

	test("completes a single root agent with canvasOutput metadata", async () => {
		const plan = makePlan([
			{
				...makeNode("A"),
				canvasOutput: { type: "markdown", title: "Summary" },
			},
		]);
		const scheduler = new QueueScheduler({
			concurrency: 1,
			runAgent: createMockRunner(new Map([["A", mockResult("A")]])),
		});

		const results = await scheduler.execute(plan);
		expect(results.get("A")?.state).toBe("completed");
	});

	test("passes upstream results through a linear chain", async () => {
		const plan = makePlan([makeNode("A"), makeNode("B", ["A"])]);
		const upstreamSeen = new Map<string, Map<string, SingleResult>>();
		const runner: RunAgentFn = async (node, upstreamResults) => {
			upstreamSeen.set(node.id, new Map(upstreamResults));
			return mockResult(node.id, `output-${node.id}`);
		};
		const scheduler = new QueueScheduler({ concurrency: 2, runAgent: runner });

		await scheduler.execute(plan);

		expect(upstreamSeen.get("A")?.size).toBe(0);
		const bUpstream = upstreamSeen.get("B");
		expect(bUpstream?.size).toBe(1);
		expect(bUpstream?.get("A")?.id).toBe("A");
		expect(bUpstream?.get("A")?.output).toBe("output-A");
	});

	test("runs parallel root agents concurrently", async () => {
		const plan = makePlan([makeNode("A"), makeNode("B")]);
		const starts = new Map<string, number>();
		const ends = new Map<string, number>();
		const runner: RunAgentFn = async node => {
			starts.set(node.id, Date.now());
			await Bun.sleep(80);
			ends.set(node.id, Date.now());
			return mockResult(node.id);
		};
		const scheduler = new QueueScheduler({ concurrency: 2, runAgent: runner });

		await scheduler.execute(plan);

		const startA = starts.get("A") ?? 0;
		const startB = starts.get("B") ?? 0;
		const endA = ends.get("A") ?? 0;
		const endB = ends.get("B") ?? 0;
		const earlierStart = Math.min(startA, startB);
		const laterStart = Math.max(startA, startB);
		const earlierEnd = startA <= startB ? endA : endB;

		expect(earlierStart).toBeGreaterThan(0);
		expect(laterStart).toBeGreaterThan(0);
		expect(earlierEnd).toBeGreaterThan(0);
		expect(laterStart).toBeLessThan(earlierEnd);
	});

	test("respects concurrency limit and runs serially when concurrency is 1", async () => {
		const plan = makePlan([makeNode("A"), makeNode("B"), makeNode("C")]);
		let active = 0;
		let maxActive = 0;
		const runner: RunAgentFn = async node => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			try {
				await Bun.sleep(40);
				return mockResult(node.id);
			} finally {
				active -= 1;
			}
		};
		const scheduler = new QueueScheduler({ concurrency: 1, runAgent: runner });

		const results = await scheduler.execute(plan);

		expect(maxActive).toBe(1);
		expect(results.get("A")?.state).toBe("completed");
		expect(results.get("B")?.state).toBe("completed");
		expect(results.get("C")?.state).toBe("completed");
	});

	test("marks dependents failed when a dependency fails", async () => {
		const plan = makePlan([makeNode("A"), makeNode("B", ["A"])]);
		const started: string[] = [];
		const runner: RunAgentFn = async (node, _upstreamResults) => {
			started.push(node.id);
			return createFailingRunner(new Set(["A"]))(node, new Map());
		};
		const scheduler = new QueueScheduler({ concurrency: 2, runAgent: runner });

		const results = await scheduler.execute(plan);

		expect(started).toEqual(["A"]);
		expect(results.get("A")?.state).toBe("failed");
		expect(results.get("A")?.error).toBe("Agent A failed");
		expect(results.get("B")?.state).toBe("failed");
		expect(results.get("B")?.error).toBe("Dependency failed");
	});

	test("passes both branch outputs to a diamond fan-in dependent", async () => {
		const plan = makePlan([makeNode("A"), makeNode("B", ["A"]), makeNode("C", ["A"]), makeNode("D", ["B", "C"])]);
		const upstreamSeen = new Map<string, Map<string, SingleResult>>();
		const runner: RunAgentFn = async (node, upstreamResults) => {
			upstreamSeen.set(node.id, new Map(upstreamResults));
			return mockResult(node.id);
		};
		const scheduler = new QueueScheduler({ concurrency: 2, runAgent: runner });

		await scheduler.execute(plan);

		const dUpstream = upstreamSeen.get("D");
		expect(dUpstream?.size).toBe(2);
		expect(dUpstream?.get("B")?.id).toBe("B");
		expect(dUpstream?.get("C")?.id).toBe("C");
	});

	test("emits state transition events for an agent", async () => {
		const plan = makePlan([makeNode("A")]);
		const events: FluidEvent[] = [];
		const scheduler = new QueueScheduler({
			concurrency: 1,
			runAgent: createMockRunner(new Map([["A", mockResult("A")]])),
			onEvent: event => {
				events.push(event);
			},
		});

		await scheduler.execute(plan);

		const transitions = events
			.filter(
				(event): event is Extract<FluidEvent, { type: "agent_state_change" }> =>
					event.type === "agent_state_change",
			)
			.filter(event => event.agentId === "A")
			.map(event => event.state);
		expect(transitions).toEqual(["ready", "running", "completed"]);
	});

	test("rejects when aborted mid-flight", async () => {
		const plan = makePlan([makeNode("A")]);
		const controller = new AbortController();
		const scheduler = new QueueScheduler({
			concurrency: 1,
			runAgent: async node => {
				await Bun.sleep(100);
				return mockResult(node.id);
			},
			signal: controller.signal,
		});

		const pending = scheduler.execute(plan);
		await Bun.sleep(10);
		controller.abort();

		await expect(pending).rejects.toThrow("Fluid execution aborted");
	});
});

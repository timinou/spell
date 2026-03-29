import { describe, expect, it } from "bun:test";
import { LOOP_STATES, type LoopEvent } from "../../src/loop/contracts";
import { LoopKernel } from "../../src/loop/kernel";
import { buildIterationPrompt } from "../../src/loop/prompt-builder";

function createEventBuffer() {
	const events: LoopEvent[] = [];
	return {
		events,
		kernel: new LoopKernel({
			onEvent: event => {
				events.push(event);
			},
		}),
	};
}

describe("LoopKernel", () => {
	it("transitions planning -> iterating -> planning on the happy path", () => {
		const { kernel } = createEventBuffer();
		const loop = kernel.start({ name: "demo", taskContent: "Initial task" });
		expect(loop.state).toBe(LOOP_STATES.planning);

		const iterating = kernel.done(loop.id);
		expect(iterating.state).toBe(LOOP_STATES.iterating);

		const nextPlanning = kernel.done(loop.id, { summary: "done", changedFiles: ["src/index.ts"] });
		expect(nextPlanning.state).toBe(LOOP_STATES.planning);
		expect(nextPlanning.iteration).toBe(1);
	});

	it("pauses and resumes active loops", () => {
		const { kernel } = createEventBuffer();
		const loop = kernel.start({ name: "pauseable" });
		kernel.done(loop.id);
		const paused = kernel.pause(loop.id, "manual");
		expect(paused.state).toBe(LOOP_STATES.paused);
		const resumed = kernel.resume(loop.id);
		expect(resumed.state).toBe(LOOP_STATES.iterating);
	});

	it("rejects invalid transitions from terminal states", () => {
		const { kernel } = createEventBuffer();
		const loop = kernel.start({ name: "terminal", maxIterations: 1 });
		kernel.done(loop.id);
		kernel.done(loop.id, { summary: "one" });
		kernel.done(loop.id);
		expect(() => kernel.done(loop.id)).toThrow("Cannot advance loop from terminal state complete");
	});

	it("moves to validating when max iterations are reached", () => {
		const { kernel } = createEventBuffer();
		const loop = kernel.start({ name: "limited", maxIterations: 1 });
		kernel.done(loop.id);
		const validating = kernel.done(loop.id, { summary: "limit" });
		expect(validating.state).toBe(LOOP_STATES.validating);
	});

	it("emits loop events for state and iteration changes", () => {
		const { kernel, events } = createEventBuffer();
		const loop = kernel.start({ name: "events" });
		kernel.done(loop.id);
		kernel.done(loop.id, { summary: "iteration done" });
		expect(events.map(event => event.type)).toEqual([
			"loop.created",
			"loop.state_changed",
			"loop.iteration_completed",
			"loop.state_changed",
		]);
		expect(events.every(event => event.loopId === loop.id)).toBe(true);
	});

	it("enforces the configured concurrency limit", () => {
		const kernel = new LoopKernel({ concurrencyLimit: 2 });
		kernel.start({ name: "one" });
		kernel.start({ name: "two" });
		expect(() => kernel.start({ name: "three" })).toThrow("Loop concurrency limit reached (2)");
	});

	it("builds fresh iteration prompts from current task content", () => {
		const prompt = buildIterationPrompt({
			loopId: "LOOP-1",
			name: "demo",
			iteration: 2,
			state: LOOP_STATES.iterating,
			taskContent: "Updated task body",
			changedFiles: ["src/index.ts"],
			openFindings: ["missing test"],
			pendingGates: ["gate-1"],
		});
		expect(prompt).toContain("Updated task body");
		expect(prompt).toContain("src/index.ts");
		expect(prompt).toContain("missing test");
	});
});

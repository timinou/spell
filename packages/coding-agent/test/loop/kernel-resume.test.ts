import { describe, expect, it } from "bun:test";
import { LOOP_STATES, type LoopEvent } from "../../src/loop/contracts";
import { LoopKernel } from "../../src/loop/kernel";

function createKernel() {
	const events: LoopEvent[] = [];
	return { events, kernel: new LoopKernel({ onEvent: e => events.push(e) }) };
}

describe("LoopKernel.resume()", () => {
	it("resumes to planning when paused from planning", () => {
		const { kernel } = createKernel();
		const loop = kernel.start({ name: "test", manifestBuilding: true });
		kernel.done(loop.id);
		kernel.pause(loop.id);
		const resumed = kernel.resume(loop.id);
		expect(resumed.state).toBe(LOOP_STATES.planning);
	});

	it("resumes to iterating when paused from iterating", () => {
		const { kernel } = createKernel();
		const loop = kernel.start({ name: "test", manifestBuilding: true });
		kernel.done(loop.id); // -> planning
		kernel.done(loop.id); // -> iterating
		kernel.pause(loop.id);
		const resumed = kernel.resume(loop.id);
		expect(resumed.state).toBe(LOOP_STATES.iterating);
	});

	it("resumes to manifest_building when paused from manifest_building", () => {
		const { kernel } = createKernel();
		const loop = kernel.start({ name: "test", manifestBuilding: true });
		kernel.pause(loop.id);
		const resumed = kernel.resume(loop.id);
		expect(resumed.state).toBe(LOOP_STATES.manifestBuilding);
	});

	it("falls back to iterating when stateBeforePause not in allowed targets", () => {
		const { kernel } = createKernel();
		const loop = kernel.start({ name: "test", reflectEvery: 1 });
		kernel.done(loop.id); // -> iterating
		kernel.done(loop.id); // -> reflecting (iteration 1 % 1 === 0)
		kernel.pause(loop.id);
		const resumed = kernel.resume(loop.id);
		expect(resumed.state).toBe(LOOP_STATES.iterating);
	});

	it("defaults to iterating when stateBeforePause is undefined (legacy)", () => {
		const { kernel } = createKernel();
		const loop = kernel.start({ name: "test" });
		kernel.done(loop.id); // -> iterating
		kernel.pause(loop.id);
		// Clear stateBeforePause to simulate legacy data
		kernel.updateLoop(loop.id, l => {
			l.stateBeforePause = undefined;
		});
		const resumed = kernel.resume(loop.id);
		expect(resumed.state).toBe(LOOP_STATES.iterating);
	});
});

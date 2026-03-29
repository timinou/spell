import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { IntegrationJourney } from "../../helpers/integration-journey";
import { StubLoopResponder } from "../../helpers/stub-llm";

describe("loop full pipeline", () => {
	let journey: IntegrationJourney;
	let responder: StubLoopResponder;

	beforeEach(async () => {
		responder = new StubLoopResponder();
		responder.set("plan", { summary: "plan" });
		responder.set("code", { summary: "code", changedFiles: ["src/index.ts"] });
		responder.set("review", { summary: "review" });
		journey = await IntegrationJourney.create(responder);
	});

	afterEach(async () => {
		await journey.teardown();
	});

	it("imports specs, starts a loop, and advances an iteration", async () => {
		await journey.writeSpec(
			"spec.org",
			"#+TITLE: Spec\n#+CUSTOM_ID: SPEC-001-demo\n\n* Acceptance Criteria\n- done\n",
		);
		const imported = await journey.importSpecs();
		expect(imported.length).toBe(1);
		await journey.commitAll("import specs");
		const loop = await journey.loop.startLoop({
			name: "pipeline",
			taskContent: "Build it",
			domains: [],
			maxIterations: 2,
		});
		const updated = await journey.loop.advanceIteration(loop.id);
		expect(updated.iteration).toBe(1);
		expect(updated.state).toBe("planning");
	});

	it("spawns a child loop and kills the tree", async () => {
		const parent = await journey.loop.startLoop({ name: "parent", domains: [] });
		await journey.commitAll("checkpoint parent loop");
		const child = await journey.loop.manager.spawnChild(parent.id, { name: "child", domains: [] });
		expect(journey.loop.manager.getLoop(parent.id).childLoopIds).toContain(child.id);
		const killed = await journey.loop.manager.kill(parent.id);
		expect(killed.map(item => item.id)).toEqual(expect.arrayContaining([parent.id, child.id]));
	});
});

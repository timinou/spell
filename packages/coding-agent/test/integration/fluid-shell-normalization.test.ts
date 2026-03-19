import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { SIMPLE_PLAN } from "../helpers/fluid-test-data";
import { isBridgeAvailable, QmlJourney } from "../helpers/qml-journey";

const FLUID_SHELL_QML = "FluidShell.qml";

describe.skipIf(!isBridgeAvailable())("FluidShell plan normalization", () => {
	let journey: QmlJourney;

	beforeAll(async () => {
		journey = await QmlJourney.launch(FLUID_SHELL_QML);
		await journey.settle(100);
	});

	afterAll(async () => {
		await journey.teardown();
	});

	beforeEach(async () => {
		await journey.agentSends({ type: "fluid:plan_start" });
	});

	it("normalizes agents array", async () => {
		await journey.agentSends({ type: "fluid:plan_complete", plan: SIMPLE_PLAN });

		expect(await journey.evaluate<number>("agentsModel.count")).toBe(2);
		expect(await journey.evaluate<string>("agentsModel.get(0).agentId")).toBe("analyze");
		expect(await journey.evaluate<string>("agentsModel.get(1).agentId")).toBe("fix");
		expect(await journey.evaluate<string>("agentsModel.get(0).agentTask")).toBe("Analyze the code");
		expect(await journey.evaluate<string>("root.state")).toBe("executing");
	});

	it("normalizes nodes and dag.agents plan variants", async () => {
		await journey.agentSends({
			type: "fluid:plan_complete",
			plan: { nodes: [{ id: "node-a", task: "Node task" }] },
		});
		expect(await journey.evaluate<number>("agentsModel.count")).toBe(1);
		expect(await journey.evaluate<string>("agentsModel.get(0).agentId")).toBe("node-a");
		expect(await journey.evaluate<string>("agentsModel.get(0).agentTask")).toBe("Node task");

		await journey.agentSends({ type: "fluid:plan_start" });
		await journey.agentSends({
			type: "fluid:plan_complete",
			plan: { dag: { agents: [{ id: "dag-a", task: "Dag task" }] } },
		});
		expect(await journey.evaluate<number>("agentsModel.count")).toBe(1);
		expect(await journey.evaluate<string>("agentsModel.get(0).agentId")).toBe("dag-a");
		expect(await journey.evaluate<string>("agentsModel.get(0).agentTask")).toBe("Dag task");
	});

	it("supports alternate agent keys and null fallback id", async () => {
		await journey.agentSends({
			type: "fluid:plan_complete",
			plan: {
				agents: [{ agentId: "alt-agent", description: "Use alternate fields" }, null],
			},
		});

		expect(await journey.evaluate<number>("agentsModel.count")).toBe(2);
		expect(await journey.evaluate<string>("agentsModel.get(0).agentId")).toBe("alt-agent");
		expect(await journey.evaluate<string>("agentsModel.get(0).agentTask")).toBe("Use alternate fields");
		expect(await journey.evaluate<string>("agentsModel.get(1).agentId")).toBe("agent-1");
		expect(await journey.evaluate<string>("agentsModel.get(1).agentTask")).toBe("");
	});

	it("moves immediately to complete state for empty plans", async () => {
		await journey.agentSends({ type: "fluid:plan_complete", plan: {} });

		expect(await journey.evaluate<string>("root.state")).toBe("complete");
		expect(await journey.evaluate<number>("agentsModel.count")).toBe(0);
		expect(await journey.evaluate<number>("root.totalCount")).toBe(0);
	});

	it("tracks single-agent totals", async () => {
		await journey.agentSends({
			type: "fluid:plan_complete",
			plan: { agents: [{ id: "solo", task: "Single agent" }] },
		});

		expect(await journey.evaluate<number>("agentsModel.count")).toBe(1);
		expect(await journey.evaluate<number>("root.totalCount")).toBe(1);
		expect(await journey.evaluate<string>("root.state")).toBe("executing");
	});
});

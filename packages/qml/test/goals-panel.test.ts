import { describe, expect, it } from "bun:test";
import { buildGoalsPanelModel } from "../src/goals-panel";

describe("goals panel model", () => {
	it("aggregates goal counts from shared sync state", () => {
		const model = buildGoalsPanelModel({
			approvals: [],
			checkpoints: [],
			downstreamJobs: [],
			audit: [],
			goals: [
				{ id: "discover", data: { state: "pending", title: "Discover" } },
				{ id: "publish", data: { state: "completed", title: "Publish" } },
			],
		});
		expect(model.goalCount).toBe(2);
		expect(model.statusCounts).toEqual({ pending: 1, completed: 1 });
		expect(model.entries[0]).toEqual({ id: "discover", state: "pending", title: "Discover" });
	});
});

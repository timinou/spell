import { describe, expect, it } from "bun:test";
import { buildApprovalSurfaceModel } from "../src/approval-surface";

describe("approval surface model", () => {
	it("summarizes approvals and checkpoints from shared state", () => {
		const model = buildApprovalSurfaceModel({
			approvals: [
				{
					id: "approval-1",
					kind: "approval",
					title: "First approval",
					state: "pending",
					allowedActions: ["approve"],
					artifactCount: 1,
				},
			],
			checkpoints: [
				{
					id: "checkpoint-1",
					kind: "checkpoint",
					title: "Checkpoint",
					state: "completed",
					allowedActions: [],
					artifactCount: 0,
				},
			],
			downstreamJobs: [],
			audit: [],
			goals: [],
		});
		expect(model.pendingCount).toBe(1);
		expect(model.completedCount).toBe(1);
		expect(model.entries.map(entry => entry.id)).toEqual(["checkpoint-1", "approval-1"]);
	});
});

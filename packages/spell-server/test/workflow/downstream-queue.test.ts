import { describe, expect, it } from "bun:test";
import { WorkflowEngine } from "../../src/workflow";
import { createActor, createApprovalInput } from "./test-helpers";

describe("workflow downstream queue", () => {
	it("queues jobs and enforces per-kind and global concurrency limits", async () => {
		const engine = new WorkflowEngine({
			downstreamConfig: {
				globalLimit: 2,
				perKindLimit: {
					feed: 1,
					export: 1,
				},
			},
		});
		const actions = [
			{
				id: "approve",
				label: "Approve",
				fromStates: ["pending"],
				toState: "approved",
				downstreamJobs: [{ kind: "feed" }, { kind: "feed" }, { kind: "export" }],
			},
		];
		const approval = engine.createApproval(createApprovalInput({ actions }));
		const actor = createActor("operator-1");
		engine.claimItem({ itemId: approval.id, actor, requestId: "claim-1" });
		const result = await engine.applyAction({
			itemId: approval.id,
			actionId: "approve",
			actor,
			requestId: "approve-1",
		});

		expect(result.queuedJobs).toHaveLength(3);
		const started = engine.startAvailableDownstreamJobs();
		expect(started.map(job => job.kind).sort()).toEqual(["export", "feed"]);

		engine.markDownstreamJobSucceeded(started.find(job => job.kind === "feed")!.id, "/tmp/feed.json");
		engine.markDownstreamJobFailed(started.find(job => job.kind === "export")!.id, "network error", true);
		const restarted = engine.startAvailableDownstreamJobs();
		expect(restarted).toHaveLength(1);
		expect(restarted[0].kind).toBe("feed");
		expect(engine.listJobs({ status: "FAILED" })[0].retryEligible).toBe(true);
	});
});

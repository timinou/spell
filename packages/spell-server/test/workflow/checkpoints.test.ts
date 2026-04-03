import { describe, expect, it } from "bun:test";
import { createActor, createCheckpointInput, createWorkflowEngine } from "./test-helpers";

describe("workflow checkpoints", () => {
	it("supports pause-and-resume, fail-run, follow-up goal, and create-approval effects", async () => {
		const engine = createWorkflowEngine();
		const actor = createActor("operator-1");

		const resumeCheckpoint = engine.createCheckpoint(createCheckpointInput({ title: "Resume checkpoint" }));
		engine.claimItem({ itemId: resumeCheckpoint.id, actor, requestId: "claim-resume" });
		const resumed = await engine.applyAction({
			itemId: resumeCheckpoint.id,
			actionId: "resume",
			actor,
			requestId: "resume-1",
		});
		expect(resumed.item.kind).toBe("checkpoint");
		expect(resumed.item.state).toBe("completed");
		expect(resumed.item.kind === "checkpoint" ? resumed.item.runStatus : undefined).toBe("resumed");

		const failCheckpoint = engine.createCheckpoint(createCheckpointInput({ title: "Fail checkpoint" }));
		engine.claimItem({ itemId: failCheckpoint.id, actor, requestId: "claim-fail" });
		const failed = await engine.applyAction({
			itemId: failCheckpoint.id,
			actionId: "fail-run",
			actor,
			requestId: "fail-1",
			reason: "validation failed",
		});
		expect(failed.item.kind === "checkpoint" ? failed.item.runStatus : undefined).toBe("failed");

		const followupCheckpoint = engine.createCheckpoint(createCheckpointInput({ title: "Follow-up checkpoint" }));
		engine.claimItem({ itemId: followupCheckpoint.id, actor, requestId: "claim-followup" });
		const followup = await engine.applyAction({
			itemId: followupCheckpoint.id,
			actionId: "trigger-followup",
			actor,
			requestId: "followup-1",
		});
		expect(followup.triggeredGoals).toEqual(["publish-approved"]);

		const approvalCheckpoint = engine.createCheckpoint(createCheckpointInput({ title: "Spawn approval checkpoint" }));
		engine.claimItem({ itemId: approvalCheckpoint.id, actor, requestId: "claim-approval" });
		const spawned = await engine.applyAction({
			itemId: approvalCheckpoint.id,
			actionId: "request-another-approval",
			actor,
			requestId: "spawn-1",
		});
		expect(spawned.spawnedApproval?.kind).toBe("approval");
		expect(spawned.spawnedApproval?.linkedCheckpointId).toBe(approvalCheckpoint.id);
	});
});

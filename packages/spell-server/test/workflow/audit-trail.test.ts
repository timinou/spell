import { describe, expect, it } from "bun:test";
import { createActor, createApprovalInput, createWorkflowEngine } from "./test-helpers";

describe("workflow audit trail", () => {
	it("records claim, action, downstream, and failure history in order", async () => {
		const engine = createWorkflowEngine();
		const approval = engine.createApproval(
			createApprovalInput({
				actions: [
					{
						id: "approve",
						label: "Approve",
						fromStates: ["pending"],
						toState: "approved",
						downstreamJobs: [{ kind: "feed" }],
					},
				],
			}),
		);
		const actor = createActor("operator-1");
		engine.claimItem({ itemId: approval.id, actor, requestId: "claim-1" });
		await engine.applyAction({ itemId: approval.id, actionId: "approve", actor, requestId: "approve-1" });
		const started = engine.startAvailableDownstreamJobs();
		engine.markDownstreamJobFailed(started[0].id, "send failed", true);

		expect(engine.listAudit(approval.id).map(entry => entry.kind)).toEqual([
			"item-created",
			"claim-acquired",
			"action-applied",
			"downstream-queued",
			"downstream-started",
			"downstream-failed",
		]);
	});
});

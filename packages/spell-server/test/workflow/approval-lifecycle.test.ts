import { describe, expect, it } from "bun:test";
import { createActor, createApprovalInput, createClock, createWorkflowEngine } from "./test-helpers";

describe("workflow approval lifecycle", () => {
	it("creates, lists, filters, and applies approval actions by state policy", async () => {
		const clock = createClock();
		const engine = createWorkflowEngine(clock.now);
		const approval = engine.createApproval(createApprovalInput());

		expect(engine.listItems()).toHaveLength(1);
		expect(engine.listItems({ kind: "approval", state: "pending" }).map(item => item.id)).toEqual([approval.id]);
		expect(engine.getAllowedActions(approval.id)).toEqual(["approve", "reject", "defer"]);

		const actor = createActor("operator-1");
		engine.claimItem({ itemId: approval.id, actor, requestId: "claim-1" });
		const result = await engine.applyAction({
			itemId: approval.id,
			actionId: "approve",
			actor,
			requestId: "approve-1",
		});

		expect(result.item.state).toBe("approved");
		expect(engine.listItems({ state: "approved" }).map(item => item.id)).toEqual([approval.id]);
		expect(engine.getAllowedActions(approval.id)).toEqual([]);
	});

	it("enforces configurable reason-required actions", async () => {
		const engine = createWorkflowEngine();
		const approval = engine.createApproval(createApprovalInput());
		const actor = createActor("operator-1");
		engine.claimItem({ itemId: approval.id, actor, requestId: "claim-1" });

		await expect(
			engine.applyAction({
				itemId: approval.id,
				actionId: "reject",
				actor,
				requestId: "reject-1",
			}),
		).rejects.toThrow(/requires a reason/);
	});
});

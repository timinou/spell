import { describe, expect, it } from "bun:test";
import { WorkflowEngine } from "../../src/workflow";
import { createActor, createApprovalInput } from "./test-helpers";

describe("workflow notification routing", () => {
	it("keeps workflow state truthful when notification delivery fails", async () => {
		const engine = new WorkflowEngine({
			notificationSender: {
				async send() {
					throw new Error("telegram unavailable");
				},
			},
		});
		const approval = engine.createApproval(
			createApprovalInput({
				notificationRoutes: [{ channel: "telegram", target: "ops-room" }],
			}),
		);
		const actor = createActor("operator-1");
		engine.claimItem({ itemId: approval.id, actor, requestId: "claim-1" });

		const result = await engine.applyAction({
			itemId: approval.id,
			actionId: "approve",
			actor,
			requestId: "approve-1",
		});

		expect(result.item.state).toBe("approved");
		expect(engine.listAudit(approval.id).map(entry => entry.kind)).toContain("notification-failed");
	});
});

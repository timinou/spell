import { describe, expect, it } from "bun:test";
import { createActor, createApprovalInput, createWorkflowEngine } from "./test-helpers";

describe("workflow action idempotency", () => {
	it("treats exact duplicate request ids as no-ops and stale requests as audited misses", async () => {
		const engine = createWorkflowEngine();
		const approval = engine.createApproval(createApprovalInput());
		const actor = createActor("operator-1");
		engine.claimItem({ itemId: approval.id, actor, requestId: "claim-1" });

		const first = await engine.applyAction({
			itemId: approval.id,
			actionId: "approve",
			actor,
			requestId: "action-1",
		});
		const duplicate = await engine.applyAction({
			itemId: approval.id,
			actionId: "approve",
			actor,
			requestId: "action-1",
		});
		const stale = await engine.applyAction({
			itemId: approval.id,
			actionId: "approve",
			actor,
			requestId: "action-2",
		});

		expect(first.duplicate).toBe(false);
		expect(duplicate.duplicate).toBe(true);
		expect(stale.stale).toBe(true);
		const audit = engine.listAudit(approval.id);
		expect(audit.filter(entry => entry.kind === "action-applied")).toHaveLength(1);
		expect(audit.filter(entry => entry.kind === "request-duplicate")).toHaveLength(1);
		expect(audit.filter(entry => entry.kind === "request-stale")).toHaveLength(1);
		expect(audit.slice(-3).map(entry => entry.kind)).toEqual([
			"action-applied",
			"request-duplicate",
			"request-stale",
		]);
	});
});

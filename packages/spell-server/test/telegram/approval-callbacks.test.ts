import { describe, expect, it } from "bun:test";
import { WorkflowEngine } from "../../src/workflow";
import { applyTelegramQuickAction } from "../../src/telegram/workflow-inbox";
import { createActor, createApprovalInput } from "../workflow/test-helpers";

describe("telegram approval callbacks", () => {
	it("claims and applies quick actions through the canonical workflow engine", async () => {
		const engine = new WorkflowEngine();
		const approval = engine.createApproval(createApprovalInput({ title: "Approve digest" }));
		const actor = createActor("telegram-user");

		const applied = await applyTelegramQuickAction(engine, {
			itemId: approval.id,
			actionId: "approve",
			actor,
			requestId: "telegram-1",
		});
		expect(applied.item.state).toBe("approved");
		expect(applied.item.claim).toBeUndefined();
	});

	it("clears the transient claim when a completed callback is replayed", async () => {
		const engine = new WorkflowEngine();
		const approval = engine.createApproval(createApprovalInput({ title: "Approve digest" }));
		const actor = createActor("telegram-user");

		await applyTelegramQuickAction(engine, {
			itemId: approval.id,
			actionId: "approve",
			actor,
			requestId: "telegram-1",
		});

		const duplicate = await applyTelegramQuickAction(engine, {
			itemId: approval.id,
			actionId: "approve",
			actor,
			requestId: "telegram-1",
		});

		expect(duplicate.duplicate).toBe(true);
		expect(duplicate.item.claim).toBeUndefined();
		expect(engine.requireItem(approval.id).claim).toBeUndefined();
	});
});

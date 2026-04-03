import { describe, expect, it } from "bun:test";
import { WorkflowEngine } from "../../src/workflow";
import { buildTelegramApprovalInbox } from "../../src/telegram/workflow-inbox";
import { createApprovalInput, createCheckpointInput } from "../workflow/test-helpers";

describe("telegram approval inbox", () => {
	it("lists pending approvals and checkpoints as quick-action inbox entries", () => {
		const engine = new WorkflowEngine();
		engine.createApproval(createApprovalInput({ title: "Approve digest" }));
		engine.createCheckpoint(createCheckpointInput({ title: "Export checkpoint" }));
		const inbox = buildTelegramApprovalInbox(engine);
		expect(inbox).toHaveLength(2);
		expect(inbox[0]).toEqual(expect.objectContaining({ title: "Approve digest" }));
		expect(inbox[0]?.actions.some(action => action.id === "approve")).toBe(true);
		expect(inbox[1]).toEqual(expect.objectContaining({ title: "Export checkpoint" }));
		expect(inbox[1]?.actions.some(action => action.id === "resume")).toBe(true);
	});
});

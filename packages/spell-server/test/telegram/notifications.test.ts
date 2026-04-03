import { describe, expect, it } from "bun:test";
import { WorkflowEngine } from "../../src/workflow";
import { buildWorkflowNotificationText } from "../../src/telegram/workflow-notifications";
import { createApprovalInput } from "../workflow/test-helpers";

describe("telegram notifications", () => {
	it("formats canonical workflow items for telegram delivery", () => {
		const engine = new WorkflowEngine();
		const approval = engine.createApproval(createApprovalInput({ title: "Approve digest" }));
		expect(buildWorkflowNotificationText(approval)).toBe(
			`Approval: Approve digest\nState: pending\nTarget: article-1`,
		);
	});
});

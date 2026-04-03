import { afterEach, describe, expect, it } from "bun:test";
import { WorkflowEngine } from "../../../spell-server/src/workflow";
import { fetchApprovalsToolView } from "../../src/tools/approvals-tool";
import { createApprovalInput } from "../../../spell-server/test/workflow/test-helpers";
import { startWorkflowHttpServer } from "../../../spell-server/test/http/workflow-test-helpers";

let stop: (() => void) | undefined;

afterEach(() => {
	stop?.();
	stop = undefined;
});

describe("approvals tool client", () => {
	it("reads canonical approval summaries from spell-server", async () => {
		const workflowEngine = new WorkflowEngine();
		workflowEngine.createApproval(createApprovalInput({ title: "Approve digest" }));
		const server = startWorkflowHttpServer({ workflowEngine });
		stop = server.stop;

		expect(
			await fetchApprovalsToolView({
				baseUrl: server.baseUrl,
				username: "spell",
				password: "secret", // pragma: allowlist secret
			}),
		).toEqual([expect.objectContaining({ title: "Approve digest", kind: "approval", state: "pending" })]);
	});
});

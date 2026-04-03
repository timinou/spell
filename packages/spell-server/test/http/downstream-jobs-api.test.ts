import { afterEach, describe, expect, it } from "bun:test";
import { WorkflowEngine } from "../../src/workflow";
import { createActor, createApprovalInput } from "../workflow/test-helpers";
import { authHeaders, startWorkflowHttpServer } from "./workflow-test-helpers";

let stop: (() => void) | undefined;

afterEach(() => {
	stop?.();
	stop = undefined;
});

describe("downstream jobs api", () => {
	it("lists filtered downstream jobs and serializes attempt history", async () => {
		const workflowEngine = new WorkflowEngine();
		const approval = workflowEngine.createApproval(
			createApprovalInput({
				actions: [
					{
						id: "approve",
						label: "Approve",
						fromStates: ["pending"],
						toState: "approved",
						downstreamJobs: [{ kind: "feed" }, { kind: "export" }],
					},
				],
			}),
		);
		const actor = createActor("operator-1");
		workflowEngine.claimItem({ itemId: approval.id, actor, requestId: "claim-1" });
		await workflowEngine.applyAction({ itemId: approval.id, actionId: "approve", actor, requestId: "approve-1" });
		const started = workflowEngine.startAvailableDownstreamJobs();
		workflowEngine.markDownstreamJobSucceeded(started.find(job => job.kind === "feed")!.id, "/tmp/feed.json");
		workflowEngine.markDownstreamJobFailed(started.find(job => job.kind === "export")!.id, "network error", true);

		const server = startWorkflowHttpServer({ workflowEngine });
		stop = server.stop;

		const listResponse = await fetch(`${server.baseUrl}/api/downstream-jobs?status=FAILED`, {
			headers: authHeaders(),
		});
		expect(listResponse.status).toBe(200);
		const jobs = (await listResponse.json()) as Array<{
			kind: string;
			status: string;
			attempts: Array<{ status: string }>;
		}>;
		expect(jobs).toEqual([
			expect.objectContaining({
				kind: "export",
				status: "FAILED",
				attempts: [expect.objectContaining({ status: "FAILED" })],
			}),
		]);

		const detailResponse = await fetch(`${server.baseUrl}/api/downstream-jobs/${workflowEngine.listJobs()[0].id}`, {
			headers: authHeaders(),
		});
		expect(detailResponse.status).toBe(200);
		expect(await detailResponse.json()).toEqual(
			expect.objectContaining({
				id: workflowEngine.listJobs()[0].id,
				itemId: approval.id,
			}),
		);
	});
});

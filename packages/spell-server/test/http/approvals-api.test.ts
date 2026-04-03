import { afterEach, describe, expect, it } from "bun:test";
import { WorkflowEngine } from "../../src/workflow";
import { createActor, createApprovalInput, createCheckpointInput } from "../workflow/test-helpers";
import { authHeaders, startWorkflowHttpServer } from "./workflow-test-helpers";

let stop: (() => void) | undefined;

afterEach(() => {
	stop?.();
	stop = undefined;
});

describe("approvals api", () => {
	it("serializes approvals, checkpoints, claims, audit, and linked artifacts", async () => {
		const workflowEngine = new WorkflowEngine();
		const approval = workflowEngine.createApproval(
			createApprovalInput({
				artifacts: [{ id: "artifact-1", label: "Draft", path: "/tmp/draft.md" }],
				linkedGoal: "discover",
				linkedRunId: "run-1",
			}),
		);
		const checkpoint = workflowEngine.createCheckpoint(createCheckpointInput({ title: "Checkpoint review" }));
		workflowEngine.claimItem({
			itemId: approval.id,
			actor: createActor("operator-1"),
			requestId: "claim-1",
		});
		const server = startWorkflowHttpServer({ workflowEngine });
		stop = server.stop;

		const listResponse = await fetch(`${server.baseUrl}/api/approvals`, { headers: authHeaders() });
		expect(listResponse.status).toBe(200);
		expect(await listResponse.json()).toEqual([
			expect.objectContaining({ id: approval.id, kind: "approval", linkedGoal: "discover", linkedRunId: "run-1" }),
			expect.objectContaining({ id: checkpoint.id, kind: "checkpoint" }),
		]);

		const detailResponse = await fetch(`${server.baseUrl}/api/approvals/${approval.id}`, { headers: authHeaders() });
		expect(detailResponse.status).toBe(200);
		expect(await detailResponse.json()).toEqual(
			expect.objectContaining({
				id: approval.id,
				artifacts: [{ id: "artifact-1", label: "Draft", path: "/tmp/draft.md" }],
				audit: [
					expect.objectContaining({ kind: "item-created" }),
					expect.objectContaining({ kind: "claim-acquired" }),
				],
			}),
		);
	});

	it("creates items, claims them, and applies actions through the api", async () => {
		const workflowEngine = new WorkflowEngine();
		const server = startWorkflowHttpServer({ workflowEngine });
		stop = server.stop;

		const created = await fetch(`${server.baseUrl}/api/approvals`, {
			method: "POST",
			headers: { ...authHeaders(), "content-type": "application/json" },
			body: JSON.stringify({ kind: "approval", ...createApprovalInput() }),
		});
		expect(created.status).toBe(201);
		const createdPayload = (await created.json()) as { id: string };

		const claimed = await fetch(`${server.baseUrl}/api/approvals/${createdPayload.id}/claim`, {
			method: "POST",
			headers: { ...authHeaders(), "content-type": "application/json" },
			body: JSON.stringify({ requestId: "claim-1", actor: createActor("operator-1") }),
		});
		expect(claimed.status).toBe(200);

		const applied = await fetch(`${server.baseUrl}/api/approvals/${createdPayload.id}/actions`, {
			method: "POST",
			headers: { ...authHeaders(), "content-type": "application/json" },
			body: JSON.stringify({ requestId: "approve-1", actionId: "approve", actor: createActor("operator-1") }),
		});
		expect(applied.status).toBe(200);
		expect(await applied.json()).toEqual(
			expect.objectContaining({
				duplicate: false,
				stale: false,
				item: expect.objectContaining({ state: "approved" }),
			}),
		);
	});
});

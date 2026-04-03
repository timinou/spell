import { afterEach, describe, expect, it } from "bun:test";
import type { ManifestGoal } from "../../src/manifest";
import { authHeaders, createGoal, createGoalRun, startWorkflowHttpServer } from "./workflow-test-helpers";

let stop: (() => void) | undefined;

afterEach(() => {
	stop?.();
	stop = undefined;
});

describe("goals api", () => {
	it("serializes canonical goal list, detail, trigger, and run-history shapes", async () => {
		const goals = new Map<string, ManifestGoal>([
			[
				"discover",
				createGoal({
					action: { id: "spell.noop", params: {}, promptSlots: {} },
					prompt: undefined,
				}),
			],
			[
				"incoming",
				createGoal({
					schedule: { type: "webhook", auth: "bearer" },
					prompt: "wait for webhook",
				}),
			],
		]);
		const server = startWorkflowHttpServer({
			goals,
			states: { discover: "completed", incoming: "pending" },
			runs: { discover: [createGoalRun("discover", "completed")] },
		});
		stop = server.stop;

		const listResponse = await fetch(`${server.baseUrl}/api/goals`, { headers: authHeaders() });
		expect(listResponse.status).toBe(200);
		expect(await listResponse.json()).toEqual([
			expect.objectContaining({ name: "discover", actionId: "spell.noop", runCount: 1, status: "completed" }),
			expect.objectContaining({ name: "incoming", actionId: "spell.prompt", runCount: 0, status: "pending" }),
		]);

		const detailResponse = await fetch(`${server.baseUrl}/api/goals/discover`, { headers: authHeaders() });
		expect(detailResponse.status).toBe(200);
		expect(await detailResponse.json()).toEqual(
			expect.objectContaining({
				name: "discover",
				actionId: "spell.noop",
				runs: [expect.objectContaining({ runId: "discover-1", attempt: 1 })],
			}),
		);

		const triggerResponse = await fetch(`${server.baseUrl}/trigger/incoming`, {
			method: "POST",
			headers: { Authorization: "Bearer goal-token" },
		});
		expect(triggerResponse.status).toBe(202);
		expect(server.executor.triggeredGoals).toEqual(["incoming"]);

		const runsResponse = await fetch(`${server.baseUrl}/api/goals/discover/runs`, { headers: authHeaders() });
		expect(runsResponse.status).toBe(200);
		expect(await runsResponse.json()).toEqual([
			expect.objectContaining({ runId: "discover-1", status: "completed", attempt: 1 }),
		]);
	});
});

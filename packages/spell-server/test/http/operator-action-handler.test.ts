import { describe, expect, it } from "bun:test";
import type { OperatorAction } from "../../src/manifest/types";
import type { OperatorActionRequest } from "../../src/http/routes/operator-actions";
import { generateOperatorActionHandler } from "../../src/workflow/operator-action-generator";
import { WorkflowEngine } from "../../src/workflow";

const operatorActions: OperatorAction[] = [
	{
		id: "approve-feed",
		transitions: [{ from: "pending", to: "approved-feed" }],
		triggerGoal: "feed-delivery-goal",
		downstreamJob: { kind: "feed-delivery" },
	},
	{
		id: "approve-publication",
		transitions: [{ from: "approved-feed", to: "approved-publication" }],
		triggerGoal: "export-goal",
		downstreamJob: { kind: "publication-export" },
	},
	{
		id: "reject",
		transitions: [
			{ from: "pending", to: "rejected" },
			{ from: "approved-feed", to: "rejected" },
		],
	},
	{
		id: "defer",
		transitions: [
			{ from: "pending", to: "deferred" },
			{ from: "approved-feed", to: "deferred" },
		],
	},
];

function makeRequest(action: string, articleId = "article-1", requestId?: string): OperatorActionRequest {
	return {
		source: "telegram",
		requestId: requestId ?? crypto.randomUUID(),
		articleId,
		action: action as OperatorActionRequest["action"],
		actor: { userId: "user-1", chatId: 123 },
	};
}

describe("generateOperatorActionHandler", () => {
	it("creates approval item on first action for an article", async () => {
		const engine = new WorkflowEngine();
		const handler = generateOperatorActionHandler(operatorActions, engine);
		const result = await handler(makeRequest("approve-feed"));

		expect(result.articleId).toBe("article-1");
		expect(result.workflowState).toBe("approved-feed");
		expect(result.duplicate).toBe(false);
	});

	it("approve-feed transitions pending to approved-feed", async () => {
		const engine = new WorkflowEngine();
		const handler = generateOperatorActionHandler(operatorActions, engine);
		const result = await handler(makeRequest("approve-feed"));

		expect(result.workflowState).toBe("approved-feed");
		expect(result.triggeredGoals).toContain("feed-delivery-goal");
	});

	it("reject transitions pending to rejected", async () => {
		const engine = new WorkflowEngine();
		const handler = generateOperatorActionHandler(operatorActions, engine);
		const result = await handler(makeRequest("reject"));

		expect(result.workflowState).toBe("rejected");
		expect(result.triggeredGoals).toEqual([]);
	});

	it("reject transitions approved-feed to rejected", async () => {
		const engine = new WorkflowEngine();
		const handler = generateOperatorActionHandler(operatorActions, engine);

		// First approve, then reject
		await handler(makeRequest("approve-feed", "article-2", "req-1"));
		const result = await handler(makeRequest("reject", "article-2", "req-2"));

		expect(result.workflowState).toBe("rejected");
	});

	it("defer transitions pending to deferred", async () => {
		const engine = new WorkflowEngine();
		const handler = generateOperatorActionHandler(operatorActions, engine);
		const result = await handler(makeRequest("defer"));

		expect(result.workflowState).toBe("deferred");
	});

	it("approve-publication only works on approved-feed items", async () => {
		const engine = new WorkflowEngine();
		const handler = generateOperatorActionHandler(operatorActions, engine);

		// First approve for feed
		await handler(makeRequest("approve-feed", "article-3", "req-1"));
		// Then approve for publication
		const result = await handler(makeRequest("approve-publication", "article-3", "req-2"));

		expect(result.workflowState).toBe("approved-publication");
		expect(result.triggeredGoals).toContain("export-goal");
	});

	it("second request for same action on moved-past state returns stale", async () => {
		const engine = new WorkflowEngine();
		const handler = generateOperatorActionHandler(operatorActions, engine);

		const first = await handler(makeRequest("approve-feed", "article-4", "req-1"));
		expect(first.workflowState).toBe("approved-feed");

		// Second approve-feed on an already approved-feed article returns stale-like (no transition available)
		const second = await handler(makeRequest("approve-feed", "article-4", "req-2"));
		expect(second.workflowState).toBe("approved-feed");
		expect(second.duplicate).toBe(false);
		expect(second.triggeredGoals).toEqual([]);
	});
});

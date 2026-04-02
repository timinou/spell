import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { GoalExecutionController } from "../../src/executor/goal-executor";
import type { GoalExecutionState } from "../../src/executor/state";
import type { GoalRun } from "../../src/executor/types";
import { startHttpServer } from "../../src/http";
import type { AutonomyManifest, ManifestGoal, ManifestSetup } from "../../src/manifest";
import { GoalScheduler } from "../../src/scheduler";

class StubExecutor {
	getState(_goalName: string): GoalExecutionState {
		return "pending";
	}

	getRunHistory(_goalName: string): GoalRun[] {
		return [];
	}

	async executeGoal(goalName: string, _cwd: string): Promise<{ goalName: string }> {
		return { goalName };
	}
}

function createManifest(): AutonomyManifest {
	const defaultSetup: ManifestSetup = { domain: "coding" };
	const webhookGoal: ManifestGoal = {
		setup: "default",
		schedule: { type: "webhook", auth: "bearer" },
		prompt: "wait for webhook",
	};
	return {
		name: "spell-server",
		version: "1.0.0",
		setups: new Map([["default", defaultSetup]]),
		goals: new Map([["incoming", webhookGoal]]),
	};
}

describe("operator actions route", () => {
	let stop: (() => void) | undefined;
	let baseUrl = "";
	let delegatedRequest: unknown;

	beforeEach(() => {
		const scheduler = new GoalScheduler();
		const executor = new StubExecutor() as unknown as GoalExecutionController;
		delegatedRequest = undefined;
		const started = startHttpServer({
			executor,
			scheduler,
			manifest: createManifest(),
			config: {
				port: 0,
				auth: { username: "spell", password: "secret" }, // pragma: allowlist secret
				goalTokens: { incoming: "goal-token" },
			},
			cwd: "/repo/project",
			frontendHtml: "<html><body>Spell UI</body></html>",
			operatorActionHandler: async request => {
				delegatedRequest = request;
				return {
					articleId: request.articleId,
					workflowState: "FEED_APPROVED",
					triggeredGoals: ["feed-delivery-goal"],
					duplicate: false,
				};
			},
		});
		stop = started.stop;
		baseUrl = `http://127.0.0.1:${started.server.port}`;
	});

	afterEach(() => {
		stop?.();
		stop = undefined;
		baseUrl = "";
		delegatedRequest = undefined;
	});

	it("requires basic auth before delegating operator actions", async () => {
		const response = await fetch(`${baseUrl}/api/operator-actions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(response.status).toBe(401);
	});

	it("validates the operator action payload and delegates safe requests", async () => {
		const invalid = await fetch(`${baseUrl}/api/operator-actions`, {
			method: "POST",
			headers: {
				Authorization: `Basic ${Buffer.from("spell:secret").toString("base64")}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ source: "telegram", articleId: "article-1" }),
		});
		expect(invalid.status).toBe(400);

		const valid = await fetch(`${baseUrl}/api/operator-actions`, {
			method: "POST",
			headers: {
				Authorization: `Basic ${Buffer.from("spell:secret").toString("base64")}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				source: "telegram",
				callbackId: "cb-1",
				articleId: "article-1",
				action: "approve-feed",
				actor: { userId: "123456789", chatId: 801343188, messageId: 12 },
			}),
		});

		expect(valid.status).toBe(200);
		expect(await valid.json()).toEqual({
			articleId: "article-1",
			workflowState: "FEED_APPROVED",
			triggeredGoals: ["feed-delivery-goal"],
			duplicate: false,
		});
		expect(delegatedRequest).toEqual({
			source: "telegram",
			callbackId: "cb-1",
			articleId: "article-1",
			action: "approve-feed",
			actor: { userId: "123456789", chatId: 801343188, messageId: 12 },
		});
	});

	it("returns 501 when no operator action handler is configured", async () => {
		stop?.();
		const scheduler = new GoalScheduler();
		const executor = new StubExecutor() as unknown as GoalExecutionController;
		const started = startHttpServer({
			executor,
			scheduler,
			manifest: createManifest(),
			config: {
				port: 0,
				auth: { username: "spell", password: "secret" }, // pragma: allowlist secret
			},
			cwd: "/repo/project",
		});
		stop = started.stop;
		baseUrl = `http://127.0.0.1:${started.server.port}`;

		const response = await fetch(`${baseUrl}/api/operator-actions`, {
			method: "POST",
			headers: {
				Authorization: `Basic ${Buffer.from("spell:secret").toString("base64")}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				source: "telegram",
				callbackId: "cb-1",
				articleId: "article-1",
				action: "approve-feed",
				actor: { userId: "123456789", chatId: 801343188 },
			}),
		});

		expect(response.status).toBe(501);
	});
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { GoalExecutionController } from "../../src/executor/goal-executor";
import type { GoalExecutionState } from "../../src/executor/state";
import type { GoalRun } from "../../src/executor/types";
import { startHttpServer } from "../../src/http";
import type { AutonomyManifest, ManifestGoal, ManifestSetup } from "../../src/manifest";
import { GoalScheduler } from "../../src/scheduler";

class StubExecutor {
	#states = new Map<string, GoalExecutionState>();
	#runs = new Map<string, GoalRun[]>();
	triggeredGoals: string[] = [];

	constructor(states?: Record<string, GoalExecutionState>, runs?: Record<string, GoalRun[]>) {
		for (const [goalName, state] of Object.entries(states ?? {})) {
			this.#states.set(goalName, state);
		}
		for (const [goalName, goalRuns] of Object.entries(runs ?? {})) {
			this.#runs.set(
				goalName,
				goalRuns.map(run => ({ ...run })),
			);
		}
	}

	getState(goalName: string): GoalExecutionState {
		return this.#states.get(goalName) ?? "pending";
	}

	getRunHistory(goalName: string): GoalRun[] {
		return (this.#runs.get(goalName) ?? []).map(run => ({ ...run }));
	}

	async executeGoal(goalName: string, _cwd: string): Promise<{ goalName: string }> {
		this.triggeredGoals.push(goalName);
		return { goalName };
	}
}

function createManifest(): AutonomyManifest {
	const defaultSetup: ManifestSetup = { domain: "coding" };
	const cronGoal: ManifestGoal = {
		setup: "default",
		schedule: { type: "cron", expression: "*/10 * * * * *" },
		prompt: "do the thing",
	};
	const webhookGoal: ManifestGoal = {
		setup: "default",
		schedule: { type: "webhook", auth: "bearer" },
		prompt: "wait for webhook",
	};
	return {
		name: "spell-server",
		version: "1.0.0",
		setups: new Map([["default", defaultSetup]]),
		goals: new Map([
			["ship-it", cronGoal],
			["incoming", webhookGoal],
		]),
	};
}

function createRun(
	goalName: string,
	status: GoalRun["status"],
	completedAt = new Date("2026-04-02T12:00:00.000Z"),
): GoalRun {
	return {
		runId: `${goalName}-1`,
		goalName,
		startedAt: new Date("2026-04-02T11:59:00.000Z"),
		completedAt,
		status,
		attempt: 1,
	};
}

describe("HTTP router", () => {
	let stop: (() => void) | undefined;
	let baseUrl = "";

	beforeEach(() => {
		const scheduler = new GoalScheduler();
		scheduler.register({
			goalName: "ship-it",
			cronExpression: "*/10 * * * * *",
			jitterMs: 0,
			callback: async () => {},
		});
		const executor = new StubExecutor(
			{ "ship-it": "completed", incoming: "pending" },
			{ "ship-it": [createRun("ship-it", "completed")] },
		) as unknown as GoalExecutionController;
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
		});
		stop = started.stop;
		baseUrl = `http://127.0.0.1:${started.server.port}`;
	});

	afterEach(() => {
		stop?.();
		stop = undefined;
	});

	it("serves frontend html", async () => {
		const response = await fetch(`${baseUrl}/`);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("Spell UI");
	});

	it("rejects unauthenticated API access", async () => {
		const response = await fetch(`${baseUrl}/api/goals`);
		expect(response.status).toBe(401);
	});

	it("returns goal summaries for valid basic auth", async () => {
		const response = await fetch(`${baseUrl}/api/goals`, {
			headers: { Authorization: `Basic ${Buffer.from("spell:secret").toString("base64")}` },
		});
		expect(response.status).toBe(200);
		const payload = (await response.json()) as Array<{ name: string; status: string }>;
		expect(payload).toEqual([
			expect.objectContaining({ name: "ship-it", status: "completed" }),
			expect.objectContaining({ name: "incoming", status: "pending" }),
		]);
	});

	it("rejects malformed or invalid basic auth", async () => {
		const malformed = await fetch(`${baseUrl}/api/goals`, { headers: { Authorization: "Basic !!!" } });
		expect(malformed.status).toBe(401);
		const invalid = await fetch(`${baseUrl}/api/goals`, {
			headers: { Authorization: `Basic ${Buffer.from("spell:nope").toString("base64")}` },
		});
		expect(invalid.status).toBe(401);
	});

	it("returns goal detail", async () => {
		const response = await fetch(`${baseUrl}/api/goals/ship-it`, {
			headers: { Authorization: `Basic ${Buffer.from("spell:secret").toString("base64")}` },
		});
		expect(response.status).toBe(200);
		const payload = (await response.json()) as { name: string; runs: GoalRun[] };
		expect(payload.name).toBe("ship-it");
		expect(payload.runs).toHaveLength(1);
	});

	it("returns full run history from the logs endpoint", async () => {
		const response = await fetch(`${baseUrl}/api/goals/ship-it/logs`, {
			headers: { Authorization: `Basic ${Buffer.from("spell:secret").toString("base64")}` },
		});
		expect(response.status).toBe(200);
		const payload = (await response.json()) as Array<{
			runId: string;
			startedAt: string;
			completedAt?: string;
			status: string;
			error?: string;
			attempt: number;
		}>;
		expect(payload).toEqual([
			expect.objectContaining({
				runId: "ship-it-1",
				startedAt: "2026-04-02T11:59:00.000Z",
				completedAt: "2026-04-02T12:00:00.000Z",
				status: "completed",
				attempt: 1,
			}),
		]);
	});

	it("returns an empty logs array when a goal has no runs", async () => {
		const response = await fetch(`${baseUrl}/api/goals/incoming/logs`, {
			headers: { Authorization: `Basic ${Buffer.from("spell:secret").toString("base64")}` },
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual([]);
	});

	it("returns 404 for missing goal logs", async () => {
		const response = await fetch(`${baseUrl}/api/goals/missing/logs`, {
			headers: { Authorization: `Basic ${Buffer.from("spell:secret").toString("base64")}` },
		});
		expect(response.status).toBe(404);
	});

	it("triggers execution for a known goal", async () => {
		const response = await fetch(`${baseUrl}/trigger/ship-it`, { method: "POST" });
		expect(response.status).toBe(202);
		const payload = (await response.json()) as { goalName: string };
		expect(payload.goalName).toBe("ship-it");
	});

	it("keeps direct trigger routes working for webhook goals when legacy callers include auth", async () => {
		const response = await fetch(`${baseUrl}/trigger/incoming`, {
			method: "POST",
			headers: { Authorization: "Bearer goal-token" },
		});
		expect(response.status).toBe(202);
		const payload = (await response.json()) as { goalName: string };
		expect(payload.goalName).toBe("incoming");
	});

	it("returns 404 for missing trigger goal", async () => {
		const response = await fetch(`${baseUrl}/trigger/missing`, { method: "POST" });
		expect(response.status).toBe(404);
	});

	it("returns 404 for unknown routes", async () => {
		const response = await fetch(`${baseUrl}/unknown`);
		expect(response.status).toBe(404);
	});

	it("includes cors headers on API responses", async () => {
		const response = await fetch(`${baseUrl}/api/goals`, {
			headers: { Authorization: `Basic ${Buffer.from("spell:secret").toString("base64")}` },
		});
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
		expect(response.headers.get("Access-Control-Allow-Methods")).toContain("GET");
	});
});

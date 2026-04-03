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
		return { goalName };
	}
}

function createManifest(): AutonomyManifest {
	const defaultSetup: ManifestSetup = { domain: "coding", mode: "worker" };
	const cronGoal: ManifestGoal = {
		setup: "default",
		schedule: { type: "cron", expression: "*/10 * * * * *", timezone: "UTC" },
		prompt: "do the thing",
	};
	return {
		name: "spell-server",
		version: "1.0.0",
		setups: new Map([["default", defaultSetup]]),
		goals: new Map([["ship-it", cronGoal]]),
		exportTargets: [],
		notificationRoutes: [],
		reviewPolicies: [],
		checkpoints: [],
		panels: [],
		layouts: [],
		syncCollections: [],
		stateSchemas: [],
	};
}

function createRun(goalName: string): GoalRun {
	return {
		runId: `${goalName}-1`,
		goalName,
		startedAt: new Date("2026-04-02T11:59:00.000Z"),
		completedAt: new Date("2026-04-02T12:00:00.000Z"),
		status: "completed",
		attempt: 1,
	};
}

describe("HTTP frontend", () => {
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
			{ "ship-it": "completed" },
			{ "ship-it": [createRun("ship-it")] },
		) as unknown as GoalExecutionController;
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
	});

	afterEach(() => {
		stop?.();
		stop = undefined;
	});

	it("serves the inline dashboard html", async () => {
		const response = await fetch(`${baseUrl}/`);
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(body).toContain('<div id="app"></div>');
		expect(body).toContain('<script type="importmap">');
		expect(body).toContain('"preact": "https://esm.sh/preact@10.25.4"');
		expect(body).toContain('"htm/preact": "https://esm.sh/htm@3.1.1/preact?external=preact"');
		expect(body).toContain("import { h, render } from 'preact';");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: checking actual HTM template syntax in HTML output
		expect(body).toContain("render(html`<${App} />`, document.getElementById('app'));");
		expect(body).not.toContain("admin:admin");
		expect(body).toContain("Authentication required");
		expect(body).toContain("Enter the dashboard Basic Auth credentials to load goals, runs, and manifest data.");
		expect(body).toContain("Sign In");
	});

	it("returns a json-safe manifest payload from the api", async () => {
		const response = await fetch(`${baseUrl}/api/manifest`, {
			headers: { Authorization: `Basic ${Buffer.from("spell:secret").toString("base64")}` },
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toEqual({
			name: "spell-server",
			version: "1.0.0",
			setups: {
				default: { domain: "coding", mode: "worker" },
			},
			goals: {
				"ship-it": {
					setup: "default",
					schedule: { type: "cron", expression: "*/10 * * * * *", timezone: "UTC" },
					prompt: "do the thing",
				},
			},
		});
	});
});

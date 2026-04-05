import type { GoalExecutionController } from "../../src/executor/goal-executor";
import type { GoalExecutionState } from "../../src/executor/state";
import type { GoalRun } from "../../src/executor/types";
import { startHttpServer } from "../../src/http";
import type { AutonomyManifest, ManifestGoal, ManifestSetup } from "../../src/manifest";
import { GoalScheduler } from "../../src/scheduler";
import type { WorkflowEngine } from "../../src/workflow";

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

export function createManifest(goals: Map<string, ManifestGoal>): AutonomyManifest {
	const defaultSetup: ManifestSetup = { domain: "coding" };
	return {
		name: "spell-server",
		version: "1.0.0",
		setups: new Map([["default", defaultSetup]]),
		goals,
		exportTargets: [],
		notificationRoutes: [],
		reviewPolicies: [],
		checkpoints: [],
		panels: [],
		layouts: [],
		syncCollections: [],
		stateSchemas: [],
		toolModules: [],
		operatorActions: [],
	};
}

export function createGoalRun(goalName: string, status: GoalRun["status"]): GoalRun {
	return {
		runId: `${goalName}-1`,
		goalName,
		startedAt: new Date("2026-04-02T11:59:00.000Z"),
		completedAt: new Date("2026-04-02T12:00:00.000Z"),
		status,
		attempt: 1,
	};
}

export function createGoal(goal: Partial<ManifestGoal> = {}): ManifestGoal {
	return {
		setup: "default",
		schedule: { type: "cron", expression: "*/10 * * * * *" },
		prompt: "do the thing",
		...goal,
	};
}

export function startWorkflowHttpServer(
	options: {
		workflowEngine?: WorkflowEngine;
		goals?: Map<string, ManifestGoal>;
		states?: Record<string, GoalExecutionState>;
		runs?: Record<string, GoalRun[]>;
	} = {},
): {
	baseUrl: string;
	stop: () => void;
	executor: StubExecutor;
} {
	const scheduler = new GoalScheduler();
	for (const [goalName, goal] of options.goals ?? []) {
		if (goal.schedule.type === "cron") {
			scheduler.register({
				goalName,
				cronExpression: goal.schedule.expression,
				jitterMs: 0,
				callback: async () => {},
			});
		}
	}
	const executor = new StubExecutor(options.states, options.runs);
	const started = startHttpServer({
		executor: executor as unknown as GoalExecutionController,
		scheduler,
		manifest: createManifest(options.goals ?? new Map()),
		config: {
			port: 0,
			auth: { username: "spell", password: "secret" }, // pragma: allowlist secret
			goalTokens: { incoming: "goal-token" },
		},
		cwd: "/repo/project",
		frontendHtml: "<html><body>Spell UI</body></html>",
		workflowEngine: options.workflowEngine,
	});
	return {
		baseUrl: `http://127.0.0.1:${started.server.port}`,
		stop: started.stop,
		executor,
	};
}

export function authHeaders(): Record<string, string> {
	return {
		Authorization: `Basic ${Buffer.from("spell:secret").toString("base64")}`,
	};
}

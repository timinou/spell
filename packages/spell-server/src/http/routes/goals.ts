import type { GoalExecutionController } from "../../executor/goal-executor";
import type { GoalRun } from "../../executor/types";
import type { AutonomyManifest, ManifestGoal } from "../../manifest/types";
import type { GoalScheduler } from "../../scheduler/goal-scheduler";
import type { GoalDetail, GoalSummary, RunEntry } from "../types";

/** Recursively convert Map instances to plain objects for JSON serialization. */
function serializeValue(value: unknown): unknown {
	if (value instanceof Map) {
		const obj: Record<string, unknown> = {};
		for (const [k, v] of value) {
			obj[k] = serializeValue(v);
		}
		return obj;
	}
	if (Array.isArray(value)) {
		return value.map(serializeValue);
	}
	if (typeof value === "object" && value !== null && !(value instanceof Date)) {
		const obj: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			obj[k] = serializeValue(v);
		}
		return obj;
	}
	return value;
}

function toManifestJson(manifest: AutonomyManifest): {
	name: string;
	version: string;
	setups: Record<string, unknown>;
	goals: Record<string, unknown>;
	panels: AutonomyManifest["panels"];
	layouts: AutonomyManifest["layouts"];
	syncCollections: AutonomyManifest["syncCollections"];
	stateSchemas: AutonomyManifest["stateSchemas"];
	reviewPolicies: AutonomyManifest["reviewPolicies"];
	checkpoints: AutonomyManifest["checkpoints"];
	exportTargets: AutonomyManifest["exportTargets"];
	notificationRoutes: AutonomyManifest["notificationRoutes"];
} {
	return {
		name: manifest.name,
		version: manifest.version,
		setups: serializeValue(manifest.setups) as Record<string, unknown>,
		goals: serializeValue(manifest.goals) as Record<string, unknown>,
		panels: manifest.panels,
		layouts: manifest.layouts,
		syncCollections: manifest.syncCollections,
		stateSchemas: manifest.stateSchemas,
		reviewPolicies: manifest.reviewPolicies,
		checkpoints: manifest.checkpoints,
		exportTargets: manifest.exportTargets,
		notificationRoutes: manifest.notificationRoutes,
	};
}

function describeSchedule(goal: ManifestGoal): string {
	if (goal.schedule.type === "cron") {
		const timezoneSuffix = goal.schedule.timezone ? ` (${goal.schedule.timezone})` : "";
		return `cron: ${goal.schedule.expression}${timezoneSuffix}`;
	}

	const pathSuffix = goal.schedule.path ? ` ${goal.schedule.path}` : "";
	const authSuffix = goal.schedule.auth ? ` [${goal.schedule.auth}]` : "";
	return `webhook:${pathSuffix}${authSuffix}`.trim();
}

function toRunEntry(run: GoalRun): RunEntry {
	return {
		runId: run.runId,
		startedAt: run.startedAt.toISOString(),
		completedAt: run.completedAt?.toISOString(),
		status: run.status,
		error: run.error,
		attempt: run.attempt,
	};
}

function getActionId(goal: ManifestGoal): string | undefined {
	if (goal.action) {
		return goal.action.id;
	}
	if (goal.prompt) {
		return "spell.prompt";
	}
	return undefined;
}

function buildGoalSummary(
	name: string,
	goal: ManifestGoal,
	executor: GoalExecutionController,
	scheduler: GoalScheduler,
): GoalSummary {
	const runs = executor.getRunHistory(name);
	const lastRun = runs[runs.length - 1];
	const nextFire = scheduler.getNextFireTime(name);
	return {
		name,
		setup: goal.setup,
		schedule: describeSchedule(goal),
		actionId: getActionId(goal),
		status: executor.getState(name),
		lastRun:
			lastRun?.completedAt === undefined
				? undefined
				: {
						completedAt: lastRun.completedAt.toISOString(),
						status: lastRun.status,
					},
		nextFire: nextFire?.toISOString(),
		runCount: runs.length,
	};
}

export function handleGetGoals(
	executor: GoalExecutionController,
	scheduler: GoalScheduler,
	manifest: AutonomyManifest,
): Response {
	const goals: GoalSummary[] = [];
	for (const [name, goal] of manifest.goals) {
		goals.push(buildGoalSummary(name, goal, executor, scheduler));
	}
	return Response.json(goals);
}

export function handleGetGoal(
	goalName: string,
	executor: GoalExecutionController,
	scheduler: GoalScheduler,
	manifest: AutonomyManifest,
): Response {
	const goal = manifest.goals.get(goalName);
	if (!goal) {
		return Response.json({ error: "Goal not found" }, { status: 404 });
	}

	const detail: GoalDetail = {
		...buildGoalSummary(goalName, goal, executor, scheduler),
		config: serializeValue(goal) as ManifestGoal,
		runs: executor.getRunHistory(goalName).map(toRunEntry),
	};
	return Response.json(detail);
}

export function handleGetGoalRuns(
	goalName: string,
	executor: GoalExecutionController,
	manifest: AutonomyManifest,
): Response {
	if (!manifest.goals.has(goalName)) {
		return Response.json({ error: "Goal not found" }, { status: 404 });
	}
	return Response.json(executor.getRunHistory(goalName).map(toRunEntry));
}

export function handleGetGoalLogs(
	goalName: string,
	executor: GoalExecutionController,
	manifest: AutonomyManifest,
): Response {
	if (!manifest.goals.has(goalName)) {
		return Response.json({ error: "Goal not found" }, { status: 404 });
	}

	return Response.json(executor.getRunHistory(goalName).map(toRunEntry));
}

export function handleGetManifest(manifest: AutonomyManifest): Response {
	return Response.json(toManifestJson(manifest));
}

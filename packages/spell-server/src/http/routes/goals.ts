import type { GoalExecutionController } from "../../executor/goal-executor";
import type { GoalRun } from "../../executor/types";
import type { AutonomyManifest, ManifestGoal } from "../../manifest/types";
import type { GoalScheduler } from "../../scheduler/goal-scheduler";
import type { GoalDetail, GoalSummary, RunEntry } from "../types";

function toManifestJson(manifest: AutonomyManifest): {
	name: string;
	version: string;
	setups: Record<string, unknown>;
	goals: Record<string, unknown>;
} {
	return {
		name: manifest.name,
		version: manifest.version,
		setups: Object.fromEntries(manifest.setups),
		goals: Object.fromEntries(manifest.goals),
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
		status: executor.getState(name),
		lastRun:
			lastRun?.completedAt === undefined
				? undefined
				: {
						completedAt: lastRun.completedAt.toISOString(),
						status: lastRun.status,
					},
		nextFire: nextFire?.toISOString(),
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
		config: goal,
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

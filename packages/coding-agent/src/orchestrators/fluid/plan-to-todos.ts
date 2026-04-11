import { promoteReadyTasks, type TodoGroup, type TodoItem } from "../../tools/todo-write";
import { splitIntoComponents, topologicalOrder } from "./dag";
import type { FluidAgentNode, FluidPlan } from "./types";

export interface PlanWaveEntry {
	id: string;
	orgItemId?: string;
	step: string;
	dependsOn?: string[];
	details?: string;
	deferred?: boolean;
	layer?: string;
}

export interface PlanWave {
	name: string;
	entries: PlanWaveEntry[];
}

export interface FluidTodoPlan {
	groups: TodoGroup[];
	taskIdByAgentId: Map<string, string>;
}

interface MaterializedPlanWaves {
	groups: TodoGroup[];
	taskIdByEntryId: Map<string, string>;
}

function buildTaskDetails(agent: FluidAgentNode): string | undefined {
	const lines: string[] = [];
	const effort = agent.effort?.trim() ?? "";
	if (effort) {
		lines.push(`Effort: ${effort}`);
	}
	const priority = agent.priority?.trim() ?? "";
	if (priority) {
		lines.push(`Priority: ${priority}`);
	}
	const body = agent.body?.trim() ?? "";
	if (body) {
		if (lines.length > 0) {
			lines.push("");
		}
		lines.push(body);
	}
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function computeComponentWaves(plan: FluidPlan, componentPrefix?: string): PlanWave[] {
	const nodesById = new Map(plan.agents.map(agent => [agent.id, agent]));
	const order = topologicalOrder(plan);
	const depthById = new Map<string, number>();
	for (const agentId of order) {
		const agent = nodesById.get(agentId);
		if (!agent) continue;
		const depth =
			agent.dependsOn.length === 0 ? 0 : Math.max(...agent.dependsOn.map(depId => depthById.get(depId) ?? 0)) + 1;
		depthById.set(agentId, depth);
	}

	const entriesByDepth = new Map<number, PlanWaveEntry[]>();
	for (const agent of plan.agents) {
		const depth = depthById.get(agent.id) ?? 0;
		const entries = entriesByDepth.get(depth) ?? [];
		entries.push({
			id: agent.id,
			orgItemId: agent.orgItemId,
			step: agent.task,
			dependsOn: agent.dependsOn.length > 0 ? agent.dependsOn : undefined,
			details: buildTaskDetails(agent),
			deferred: agent.deferred,
		});
		entriesByDepth.set(depth, entries);
	}

	return [...entriesByDepth.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([depth, entries]) => ({
			name: componentPrefix ? `${componentPrefix}-wave-${depth + 1}` : `wave-${depth + 1}`,
			entries,
		}));
}

export function computeWaveLayers(plan: FluidPlan): PlanWave[] {
	const components = splitIntoComponents(plan);
	const singleComponent = components.length === 1;
	return components.flatMap((componentPlan, index) =>
		computeComponentWaves(componentPlan, singleComponent ? undefined : `component-${index + 1}`),
	);
}

function materializePlanWaves(waves: PlanWave[]): MaterializedPlanWaves {
	const visibleEntries = waves.flatMap(wave => wave.entries.filter(entry => !entry.deferred));
	const taskIdByEntryId = new Map<string, string>();
	for (const [index, entry] of visibleEntries.entries()) {
		taskIdByEntryId.set(entry.id, `task-${index + 1}`);
	}

	const closingTaskIdByOrgItemId = new Map<string, string>();
	for (const entry of visibleEntries) {
		if (!entry.orgItemId) continue;
		const taskId = taskIdByEntryId.get(entry.id);
		if (taskId) {
			closingTaskIdByOrgItemId.set(entry.orgItemId, taskId);
		}
	}

	const groups: TodoGroup[] = [];
	let nextGroupNumber = 1;
	for (const wave of waves) {
		const visibleWaveEntries = wave.entries.filter(entry => !entry.deferred);
		if (visibleWaveEntries.length === 0) {
			continue;
		}

		const tasks: TodoItem[] = visibleWaveEntries.map(entry => {
			const taskId = taskIdByEntryId.get(entry.id);
			if (!taskId) {
				throw new Error(`Missing generated task ID for wave entry ${entry.id}`);
			}
			const blockers = (entry.dependsOn ?? [])
				.map(depId => taskIdByEntryId.get(depId))
				.filter((blockerId): blockerId is string => blockerId !== undefined);
			const item: TodoItem = {
				id: taskId,
				content: entry.step,
				status: "pending",
				details: entry.details,
				blockers: blockers.length > 0 ? blockers : undefined,
				orgItemId: entry.orgItemId,
				layer: entry.layer,
			};
			if (entry.orgItemId && closingTaskIdByOrgItemId.get(entry.orgItemId) === taskId) {
				item.orgItemClosingId = entry.orgItemId;
			}
			return item;
		});

		groups.push({
			id: `group-${nextGroupNumber++}`,
			name: wave.name,
			tasks,
		});
	}

	promoteReadyTasks(groups, false);
	return { groups, taskIdByEntryId };
}

export function planWavesToTodoGroups(waves: PlanWave[]): TodoGroup[] {
	return materializePlanWaves(waves).groups;
}

export function materializeFluidPlanToTodos(plan: FluidPlan): FluidTodoPlan {
	const materialized = materializePlanWaves(computeWaveLayers(plan));
	return {
		groups: materialized.groups,
		taskIdByAgentId: materialized.taskIdByEntryId,
	};
}

export function fluidPlanToTodoGroups(plan: FluidPlan): TodoGroup[] {
	return materializeFluidPlanToTodos(plan).groups;
}

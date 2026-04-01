import type {
	FluidPlanComponent,
	FluidPlanWave,
	FluidPlanWithComponents,
	FluidPlanAgent as OrgFluidPlanAgent,
} from "@oh-my-pi/pi-org";
import type { TodoItem, TodoPhase } from "../../tools/todo-write";
import { splitIntoComponents, topologicalOrder } from "./dag";
import type { FluidPlan } from "./types";

export interface FluidTodoPlan {
	phases: TodoPhase[];
	taskIdByAgentId: Map<string, string>;
}

interface PlannedTodoTask {
	agentId: string;
	orgItemId?: string;
	dependsOn: string[];
	content: string;
	details?: string;
}

interface PlannedTodoPhase {
	name: string;
	tasks: PlannedTodoTask[];
}

interface NormalizedPlan {
	components: FluidPlanComponent[];
	warnings: string[];
}

function isPlanWithComponents(plan: FluidPlanWithComponents | FluidPlan): plan is FluidPlanWithComponents {
	return "components" in plan;
}

function computeWaveLayers(plan: FluidPlan): FluidPlanWave[] {
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

	const itemsByDepth = new Map<number, string[]>();
	for (const agent of plan.agents) {
		const depth = depthById.get(agent.id) ?? 0;
		const items = itemsByDepth.get(depth) ?? [];
		items.push(agent.id);
		itemsByDepth.set(depth, items);
	}

	return [...itemsByDepth.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([depth, items]) => ({ number: depth + 1, items }));
}

function normalizeSimplePlan(plan: FluidPlan): NormalizedPlan {
	const components = splitIntoComponents(plan).map((componentPlan, index) => ({
		id: `component-${index + 1}`,
		agents: componentPlan.agents.map(agent => ({
			id: agent.id,
			task: agent.task,
			dependsOn: agent.dependsOn,
			orgItemId: agent.orgItemId ?? "",
			effort: agent.effort ?? "",
			priority: agent.priority ?? "",
			state: "ITEM",
			body: agent.body ?? "",
			deferred: agent.deferred,
		})),
		waves: computeWaveLayers(componentPlan),
	}));
	return { components, warnings: [] };
}

function normalizePlan(plan: FluidPlanWithComponents | FluidPlan): NormalizedPlan {
	return isPlanWithComponents(plan) ? plan : normalizeSimplePlan(plan);
}

function buildTaskDetails(agent: OrgFluidPlanAgent): string | undefined {
	const lines: string[] = [];
	if (agent.effort.trim()) {
		lines.push(`Effort: ${agent.effort.trim()}`);
	}
	if (agent.priority.trim()) {
		lines.push(`Priority: ${agent.priority.trim()}`);
	}
	const body = agent.body.trim();
	if (body) {
		if (lines.length > 0) {
			lines.push("");
		}
		lines.push(body);
	}
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function buildPlannedPhases(plan: NormalizedPlan): PlannedTodoPhase[] {
	const singleComponent = plan.components.length === 1;
	const phases: PlannedTodoPhase[] = [];
	for (const component of plan.components) {
		const agentsById = new Map(component.agents.map(agent => [agent.id, agent]));
		for (const wave of component.waves) {
			const tasks: PlannedTodoTask[] = [];
			for (const agentId of wave.items) {
				const agent = agentsById.get(agentId);
				if (!agent || agent.deferred) {
					continue;
				}
				tasks.push({
					agentId: agent.id,
					orgItemId: agent.orgItemId || undefined,
					dependsOn: agent.dependsOn,
					content: agent.task,
					details: buildTaskDetails(agent),
				});
			}
			if (tasks.length === 0) {
				continue;
			}
			phases.push({
				name: singleComponent ? `wave-${wave.number}` : `${component.id}-wave-${wave.number}`,
				tasks,
			});
		}
	}
	return phases;
}

function materializePhases(phases: PlannedTodoPhase[]): FluidTodoPlan {
	const taskIdByAgentId = new Map<string, string>();
	let nextTaskNumber = 1;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			const taskId = `task-${nextTaskNumber++}`;
			taskIdByAgentId.set(task.agentId, taskId);
		}
	}

	const closingTaskIdByOrgItemId = new Map<string, string>();
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (!task.orgItemId) continue;
			const taskId = taskIdByAgentId.get(task.agentId);
			if (taskId) {
				closingTaskIdByOrgItemId.set(task.orgItemId, taskId);
			}
		}
	}

	let currentTaskNumber = 1;
	const materialized = phases.map((phase, phaseIndex) => ({
		id: `phase-${phaseIndex + 1}`,
		name: phase.name,
		tasks: phase.tasks.map(task => {
			const taskId = `task-${currentTaskNumber++}`;
			const blockers = task.dependsOn
				.map(depId => taskIdByAgentId.get(depId))
				.filter((blockerId): blockerId is string => blockerId !== undefined);
			const item: TodoItem = {
				id: taskId,
				content: task.content,
				status: "pending",
				details: task.details,
				blockers: blockers.length > 0 ? blockers : undefined,
				orgItemId: task.orgItemId,
			};
			if (task.orgItemId && closingTaskIdByOrgItemId.get(task.orgItemId) === taskId) {
				item.orgItemClosingId = task.orgItemId;
			}
			return item;
		}),
	}));

	for (const phase of materialized) {
		for (const task of phase.tasks) {
			if (!task.blockers || task.blockers.length === 0) {
				task.status = "in_progress";
				return { phases: materialized, taskIdByAgentId };
			}
		}
	}

	return { phases: materialized, taskIdByAgentId };
}

export function materializeFluidPlanToTodos(plan: FluidPlanWithComponents | FluidPlan): FluidTodoPlan {
	return materializePhases(buildPlannedPhases(normalizePlan(plan)));
}

export function fluidPlanToTodoPhases(plan: FluidPlanWithComponents | FluidPlan): TodoPhase[] {
	return materializeFluidPlanToTodos(plan).phases;
}

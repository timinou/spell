import { promoteReadyTasks, type TodoGroup, type TodoItem } from "../../tools/todo-write";
import { safeTruncateUtf8 } from "../../utils/safe-truncate-utf8";
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

export interface PlanWaveMaterializeOpts {
	planItemId?: string;
	childBodiesById?: Map<string, string>;
	todoDetailsMaxBytes?: number;
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

function trimBlankLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start]?.trim() === "") start++;
	while (end > start && lines[end - 1]?.trim() === "") end--;
	return lines.slice(start, end);
}

export function extractChildBodySection(
	orgItemId: string,
	childBodiesById: Map<string, string>,
	maxBytes: number,
): string | undefined {
	const separatorIndex = orgItemId.indexOf("::");
	const parentId = separatorIndex === -1 ? orgItemId : orgItemId.slice(0, separatorIndex);
	const suboutlineCustomId = separatorIndex === -1 ? null : orgItemId;
	const body = childBodiesById.get(parentId);
	if (!body) return undefined;

	const lines = body.split("\n");
	let capturedLines: string[] = [];

	if (suboutlineCustomId) {
		for (let i = 0; i < lines.length; i++) {
			const headingMatch = /^(\*+)\s+/.exec(lines[i] ?? "");
			if (!headingMatch || headingMatch[1].length < 2) continue;

			let j = i + 1;
			while (j < lines.length && lines[j]?.trim() === "") j++;
			if (lines[j]?.trim() !== ":PROPERTIES:") continue;

			let customId: string | undefined;
			j++;
			for (; j < lines.length; j++) {
				const trimmed = lines[j]?.trim() ?? "";
				const customIdMatch = /^:CUSTOM_ID:\s*(.+?)\s*$/u.exec(trimmed);
				if (customIdMatch) {
					customId = customIdMatch[1];
				}
				if (trimmed === ":END:") {
					j++;
					break;
				}
			}

			if (customId !== suboutlineCustomId) continue;

			let end = j;
			while (end < lines.length && !/^\*+\s+/u.test(lines[end] ?? "")) {
				end++;
			}
			capturedLines = trimBlankLines(lines.slice(j, end));
			break;
		}
	} else {
		const firstHeadingIndex = lines.findIndex(line => /^\*\s+/u.test(line));
		if (firstHeadingIndex === -1) return undefined;
		const nextHeadingIndex = lines.findIndex((line, index) => index > firstHeadingIndex && /^\*+\s+/u.test(line));
		const endIndex = nextHeadingIndex === -1 ? lines.length : nextHeadingIndex;
		capturedLines = trimBlankLines(lines.slice(firstHeadingIndex + 1, endIndex));
	}

	const captured = capturedLines.join("\n").trim();
	if (!captured) return undefined;

	const truncated = safeTruncateUtf8(captured, maxBytes);
	if (!truncated.truncated) return truncated.text;
	return `${truncated.text}\n…(elided — fetch via \`org get ${parentId}\`)`;
}

function materializePlanWaves(waves: PlanWave[], opts: PlanWaveMaterializeOpts = {}): MaterializedPlanWaves {
	const visibleEntries = waves.flatMap(wave => wave.entries.filter(entry => !entry.deferred));
	const taskIdByEntryId = new Map<string, string>();
	for (const [index, entry] of visibleEntries.entries()) {
		taskIdByEntryId.set(entry.id, `task-${index + 1}`);
	}

	const closingTaskIdByOrgItemId = new Map<string, string>();
	for (const entry of visibleEntries) {
		if (!entry.orgItemId) continue;
		const taskId = taskIdByEntryId.get(entry.id);
		if (taskId) closingTaskIdByOrgItemId.set(entry.orgItemId, taskId);
	}

	const groups: TodoGroup[] = [];
	let nextGroupNumber = 1;
	for (const [waveIndex, wave] of waves.entries()) {
		const visibleWaveEntries = wave.entries.filter(entry => !entry.deferred);
		if (visibleWaveEntries.length === 0) continue;

		const tasks: TodoItem[] = visibleWaveEntries.map(entry => {
			const taskId = taskIdByEntryId.get(entry.id);
			if (!taskId) throw new Error(`Missing generated task ID for wave entry ${entry.id}`);
			const blockers = (entry.dependsOn ?? [])
				.map(depId => taskIdByEntryId.get(depId))
				.filter((blockerId): blockerId is string => blockerId !== undefined);
			const slice =
				entry.orgItemId && opts.childBodiesById
					? extractChildBodySection(entry.orgItemId, opts.childBodiesById, opts.todoDetailsMaxBytes ?? 4096)
					: undefined;
			const details = entry.details && slice ? `${entry.details}\n\n${slice}` : (entry.details ?? slice);
			const item: TodoItem = {
				id: taskId,
				content: entry.step,
				status: "pending",
				details,
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
			planItemId: opts.planItemId,
			waveIndex: waveIndex + 1,
			tasks,
		});
	}

	promoteReadyTasks(groups, false);
	return { groups, taskIdByEntryId };
}

export function planWavesToTodoGroups(waves: PlanWave[], opts: PlanWaveMaterializeOpts = {}): TodoGroup[] {
	return materializePlanWaves(waves, opts).groups;
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

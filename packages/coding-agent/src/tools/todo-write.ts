import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { StringEnum } from "@oh-my-pi/pi-ai";
import { writeJournal } from "@oh-my-pi/pi-org";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import chalk from "chalk";
import { renderPromptTemplate } from "../config/prompt-templates";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import todoWriteDescription from "../prompts/tools/todo-write.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import type { SessionEntry } from "../session/session-manager";
import { renderStatusLine, renderTreeList } from "../tui";
import { PREVIEW_LIMITS } from "./render-utils";

// =============================================================================
// Types
// =============================================================================

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";

export interface TodoItem {
	id: string;
	content: string;
	status: TodoStatus;
	notes?: string;
	details?: string;
	gateCommit?: boolean;
	gateArtifact?: string;
	gateCmd?: string;
	gateLlm?: string;
	verifyCmd?: string;
	blockers?: string[];
}

export interface TodoPhase {
	id: string;
	name: string;
	tasks: TodoItem[];
}

export interface TodoWriteToolDetails {
	phases: TodoPhase[];
	storage: "session" | "memory";
}

// =============================================================================
// Schema
// =============================================================================

const StatusEnum = StringEnum(["pending", "in_progress", "completed", "abandoned"] as const, {
	description: "Task status",
});

const InputTask = Type.Object({
	content: Type.String({ description: "Task description" }),
	status: Type.Optional(StatusEnum),
	notes: Type.Optional(Type.String({ description: "Additional context or notes" })),
	details: Type.Optional(
		Type.String({ description: "Implementation details, file paths, and specifics (shown only when active)" }),
	),
	gateCommit: Type.Optional(Type.Boolean({ description: "Require commit after completing this task" })),
	gateArtifact: Type.Optional(Type.String({ description: "Path to artifact that must exist after completion" })),
	gateCmd: Type.Optional(Type.String({ description: "Command to run for verification" })),
	gateLlm: Type.Optional(Type.String({ description: "LLM review criteria" })),
	verifyCmd: Type.Optional(Type.String({ description: "Recommended verification command" })),
	blockers: Type.Optional(Type.Array(Type.String({ description: "Task ID that blocks this task" }))),
});

const InputPhase = Type.Object({
	name: Type.String({ description: "Phase name" }),
	tasks: Type.Optional(Type.Array(InputTask)),
});

const todoWriteSchema = Type.Object({
	ops: Type.Array(
		Type.Union([
			Type.Object({
				op: Type.Literal("replace"),
				phases: Type.Array(InputPhase),
			}),
			Type.Object({
				op: Type.Literal("add_phase"),
				name: Type.String({ description: "Phase name" }),
				tasks: Type.Optional(Type.Array(InputTask)),
			}),
			Type.Object({
				op: Type.Literal("add_task"),
				phase: Type.String({ description: "Phase ID, e.g. phase-1" }),
				content: Type.String({ description: "Task description" }),
				notes: Type.Optional(Type.String({ description: "Additional context or notes" })),
				details: Type.Optional(Type.String({ description: "Implementation details, file paths, and specifics" })),
				gateCommit: Type.Optional(Type.Boolean()),
				gateArtifact: Type.Optional(Type.String()),
				gateCmd: Type.Optional(Type.String()),
				gateLlm: Type.Optional(Type.String()),
				verifyCmd: Type.Optional(Type.String()),
				blockers: Type.Optional(Type.Array(Type.String())),
			}),
			Type.Object({
				op: Type.Literal("update"),
				id: Type.String({ description: "Task ID, e.g. task-3" }),
				status: Type.Optional(StatusEnum),
				content: Type.Optional(Type.String({ description: "Updated task description" })),
				notes: Type.Optional(Type.String({ description: "Additional context or notes" })),
				details: Type.Optional(Type.String({ description: "Updated details" })),
				gateCommit: Type.Optional(Type.Boolean()),
				gateArtifact: Type.Optional(Type.String()),
				gateCmd: Type.Optional(Type.String()),
				gateLlm: Type.Optional(Type.String()),
				verifyCmd: Type.Optional(Type.String()),
				blockers: Type.Optional(Type.Array(Type.String())),
			}),
			Type.Object({
				op: Type.Literal("remove_task"),
				id: Type.String({ description: "Task ID, e.g. task-3" }),
			}),
		]),
	),
});

type TodoWriteParams = Static<typeof todoWriteSchema>;

// =============================================================================
// File format
// =============================================================================

interface TodoFile {
	phases: TodoPhase[];
	nextTaskId: number;
	nextPhaseId: number;
}

// =============================================================================
// State helpers
// =============================================================================

function makeEmptyFile(): TodoFile {
	return { phases: [], nextTaskId: 1, nextPhaseId: 1 };
}

function findTask(phases: TodoPhase[], id: string): TodoItem | undefined {
	for (const phase of phases) {
		const task = phase.tasks.find(t => t.id === id);
		if (task) return task;
	}
	return undefined;
}

function buildPhaseFromInput(
	input: { name: string; tasks?: Array<Static<typeof InputTask>> },
	phaseId: string,
	nextTaskId: number,
): { phase: TodoPhase; nextTaskId: number } {
	const tasks: TodoItem[] = [];
	let tid = nextTaskId;
	for (const t of input.tasks ?? []) {
		tasks.push({
			id: `task-${tid++}`,
			content: t.content,
			status: t.status ?? "pending",
			notes: t.notes,
			details: t.details,
			gateCommit: t.gateCommit,
			gateArtifact: t.gateArtifact,
			gateCmd: t.gateCmd,
			gateLlm: t.gateLlm,
			verifyCmd: t.verifyCmd,
			blockers: t.blockers,
		});
	}
	return { phase: { id: phaseId, name: input.name, tasks }, nextTaskId: tid };
}

function getNextIds(phases: TodoPhase[]): { nextTaskId: number; nextPhaseId: number } {
	let maxTaskId = 0;
	let maxPhaseId = 0;

	for (const phase of phases) {
		const phaseMatch = /^phase-(\d+)$/.exec(phase.id);
		if (phaseMatch) {
			const value = Number.parseInt(phaseMatch[1], 10);
			if (Number.isFinite(value) && value > maxPhaseId) maxPhaseId = value;
		}

		for (const task of phase.tasks) {
			const taskMatch = /^task-(\d+)$/.exec(task.id);
			if (!taskMatch) continue;
			const value = Number.parseInt(taskMatch[1], 10);
			if (Number.isFinite(value) && value > maxTaskId) maxTaskId = value;
		}
	}

	return { nextTaskId: maxTaskId + 1, nextPhaseId: maxPhaseId + 1 };
}

function fileFromPhases(phases: TodoPhase[]): TodoFile {
	const { nextTaskId, nextPhaseId } = getNextIds(phases);
	return { phases, nextTaskId, nextPhaseId };
}

function clonePhases(phases: TodoPhase[]): TodoPhase[] {
	return phases.map(phase => ({ ...phase, tasks: phase.tasks.map(task => ({ ...task })) }));
}

/** Check if a task is blocked by unresolved dependencies. */
export function isTaskBlocked(task: TodoItem, allTasks: TodoItem[]): boolean {
	if (task.status !== "pending" || !task.blockers?.length) return false;
	return task.blockers.some(blockerId => {
		const blocker = allTasks.find(t => t.id === blockerId);
		// Missing blocker ref (auto-cleared task) = resolved
		if (!blocker) return false;
		return blocker.status !== "completed" && blocker.status !== "abandoned";
	});
}

function normalizeInProgressTask(phases: TodoPhase[]): void {
	const orderedTasks = phases.flatMap(phase => phase.tasks);
	if (orderedTasks.length === 0) return;

	const inProgressTasks = orderedTasks.filter(task => task.status === "in_progress");
	if (inProgressTasks.length > 1) {
		for (const task of inProgressTasks.slice(1)) {
			task.status = "pending";
		}
	}

	if (inProgressTasks.length > 0) return;

	// Skip blocked tasks when auto-promoting
	const firstPendingTask = orderedTasks.find(task => task.status === "pending" && !isTaskBlocked(task, orderedTasks));
	if (firstPendingTask) firstPendingTask.status = "in_progress";
}

export function getLatestTodoPhasesFromEntries(entries: SessionEntry[]): TodoPhase[] {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;

		const message = entry.message as { role?: string; toolName?: string; details?: unknown; isError?: boolean };
		if (message.role !== "toolResult" || message.toolName !== "todo_write" || message.isError) continue;

		const details = message.details as { phases?: unknown } | undefined;
		if (!details || !Array.isArray(details.phases)) continue;

		return clonePhases(details.phases as TodoPhase[]);
	}

	return [];
}

interface ApplyOpsResult {
	file: TodoFile;
	errors: string[];
	/** Phase IDs that became fully completed in this call. */
	completedPhaseIds: string[];
	/** Tasks that transitioned to completed and have gate fields. */
	completedGatedTasks: TodoItem[];
}

function isPhaseComplete(phase: TodoPhase): boolean {
	return phase.tasks.length > 0 && phase.tasks.every(t => t.status === "completed" || t.status === "abandoned");
}

export function hasGate(task: TodoItem): boolean {
	return !!(task.gateCommit || task.gateArtifact || task.gateCmd || task.gateLlm || task.verifyCmd);
}

function applyOps(file: TodoFile, ops: TodoWriteParams["ops"], previousPhases: TodoPhase[]): ApplyOpsResult {
	const errors: string[] = [];

	// Snapshot which phases were already complete before this call
	const wasComplete = new Map<string, boolean>();
	for (const phase of previousPhases) {
		wasComplete.set(phase.id, isPhaseComplete(phase));
	}

	// Track tasks that existed before to detect status transitions
	const previousStatus = new Map<string, TodoStatus>();
	for (const phase of previousPhases) {
		for (const task of phase.tasks) {
			previousStatus.set(task.id, task.status);
		}
	}

	for (const op of ops) {
		switch (op.op) {
			case "replace": {
				const next = makeEmptyFile();
				for (const inputPhase of op.phases) {
					const phaseId = `phase-${next.nextPhaseId++}`;
					const { phase, nextTaskId } = buildPhaseFromInput(inputPhase, phaseId, next.nextTaskId);
					next.phases.push(phase);
					next.nextTaskId = nextTaskId;
				}
				file = next;
				break;
			}

			case "add_phase": {
				const phaseId = `phase-${file.nextPhaseId++}`;
				const { phase, nextTaskId } = buildPhaseFromInput(op, phaseId, file.nextTaskId);
				file.phases.push(phase);
				file.nextTaskId = nextTaskId;
				break;
			}

			case "add_task": {
				const target = file.phases.find(p => p.id === op.phase);
				if (!target) {
					errors.push(`Phase "${op.phase}" not found`);
					break;
				}
				target.tasks.push({
					id: `task-${file.nextTaskId++}`,
					content: op.content,
					status: "pending",
					notes: op.notes,
					details: op.details,
					gateCommit: op.gateCommit,
					gateArtifact: op.gateArtifact,
					gateCmd: op.gateCmd,
					gateLlm: op.gateLlm,
					verifyCmd: op.verifyCmd,
					blockers: op.blockers,
				});
				break;
			}

			case "update": {
				const task = findTask(file.phases, op.id);
				if (!task) {
					errors.push(`Task "${op.id}" not found`);
					break;
				}
				if (op.status !== undefined) task.status = op.status;
				if (op.content !== undefined) task.content = op.content;
				if (op.notes !== undefined) task.notes = op.notes;
				if (op.details !== undefined) task.details = op.details;
				if (op.gateCommit !== undefined) task.gateCommit = op.gateCommit;
				if (op.gateArtifact !== undefined) task.gateArtifact = op.gateArtifact;
				if (op.gateCmd !== undefined) task.gateCmd = op.gateCmd;
				if (op.gateLlm !== undefined) task.gateLlm = op.gateLlm;
				if (op.verifyCmd !== undefined) task.verifyCmd = op.verifyCmd;
				if (op.blockers !== undefined) task.blockers = op.blockers;
				break;
			}

			case "remove_task": {
				let removed = false;
				for (const phase of file.phases) {
					const idx = phase.tasks.findIndex(t => t.id === op.id);
					if (idx !== -1) {
						phase.tasks.splice(idx, 1);
						removed = true;
						break;
					}
				}
				if (!removed) errors.push(`Task "${op.id}" not found`);
				break;
			}
		}
	}

	normalizeInProgressTask(file.phases);

	// Detect newly completed phases
	const completedPhaseIds: string[] = [];
	for (const phase of file.phases) {
		if (isPhaseComplete(phase) && !wasComplete.get(phase.id)) {
			completedPhaseIds.push(phase.id);
		}
	}

	// Detect tasks that transitioned to completed and have gates
	const completedGatedTasks: TodoItem[] = [];
	for (const phase of file.phases) {
		for (const task of phase.tasks) {
			if (task.status === "completed" && previousStatus.get(task.id) !== "completed" && hasGate(task)) {
				completedGatedTasks.push(task);
			}
		}
	}

	return { file, errors, completedPhaseIds, completedGatedTasks };
}

/** Build gate directive lines for a single task. */
function gateDirectivesForTask(task: TodoItem): string[] {
	const lines: string[] = [];
	if (task.gateCommit) lines.push(`REQUIRED: Commit your changes for ${task.id} (${task.content}) before proceeding.`);
	if (task.gateArtifact) lines.push(`REQUIRED: Verify artifact exists at ${task.gateArtifact} for ${task.id}.`);
	if (task.gateCmd) lines.push(`REQUIRED: Run \`${task.gateCmd}\` to verify ${task.id}.`);
	if (task.gateLlm) lines.push(`REQUIRED: Review ${task.id} against acceptance criteria: ${task.gateLlm}`);
	if (task.verifyCmd) lines.push(`RECOMMENDED: Run \`${task.verifyCmd}\` to verify ${task.id}.`);
	return lines;
}

export interface FormatSummaryOptions {
	phases: TodoPhase[];
	errors: string[];
	completedPhaseIds: string[];
	completedGatedTasks: TodoItem[];
}

export function formatSummary({
	phases,
	errors,
	completedPhaseIds,
	completedGatedTasks,
}: FormatSummaryOptions): string {
	const allTasks = phases.flatMap(p => p.tasks);
	if (allTasks.length === 0) return errors.length > 0 ? `Errors: ${errors.join("; ")}` : "Todo list cleared.";

	const remainingByPhase = phases
		.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.filter(task => task.status === "pending" || task.status === "in_progress"),
		}))
		.filter(phase => phase.tasks.length > 0);
	const remainingTasks = remainingByPhase.flatMap(phase => phase.tasks.map(task => ({ ...task, phase: phase.name })));

	// Find current phase
	let currentIdx = phases.findIndex(p => p.tasks.some(t => t.status === "pending" || t.status === "in_progress"));
	if (currentIdx === -1) currentIdx = phases.length - 1;
	const current = phases[currentIdx];
	const done = current.tasks.filter(t => t.status === "completed" || t.status === "abandoned").length;

	const lines: string[] = [];
	if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
	if (remainingTasks.length === 0) {
		lines.push("Remaining items: none.");
	} else {
		lines.push(`Remaining items (${remainingTasks.length}):`);
		for (const task of remainingTasks) {
			const blocked = isTaskBlocked(task, allTasks);
			const blockerLabel = blocked ? " [blocked]" : "";
			lines.push(`  - ${task.id} ${task.content} [${task.status}]${blockerLabel} (${task.phase})`);
			if (task.status === "in_progress" && task.details) {
				for (const line of task.details.split("\n")) {
					lines.push(`      ${line}`);
				}
			}
		}
	}
	lines.push(
		`Phase ${currentIdx + 1}/${phases.length} "${current.name}" \u2014 ${done}/${current.tasks.length} tasks complete`,
	);
	for (const phase of phases) {
		lines.push(`  ${phase.name}:`);
		for (const task of phase.tasks) {
			const blocked = isTaskBlocked(task, allTasks);
			const sym =
				task.status === "completed"
					? "\u2713"
					: task.status === "in_progress"
						? "\u2192"
						: task.status === "abandoned"
							? "\u2717"
							: blocked
								? "\u26D4"
								: "\u25CB";
			lines.push(`    ${sym} ${task.id} ${task.content}`);
		}
	}

	// Gate directives for tasks that just completed with gates
	if (completedGatedTasks.length > 0) {
		lines.push("");
		lines.push("--- Gate Requirements ---");
		for (const task of completedGatedTasks) {
			for (const directive of gateDirectivesForTask(task)) {
				lines.push(directive);
			}
		}
	}

	// Phase completion aggregate directives
	if (completedPhaseIds.length > 0) {
		for (const phaseId of completedPhaseIds) {
			const phase = phases.find(p => p.id === phaseId);
			if (!phase) continue;
			const gatedInPhase = phase.tasks.filter(hasGate);
			if (gatedInPhase.length === 0) continue;
			const actions: string[] = [];
			if (gatedInPhase.some(t => t.gateCommit)) actions.push("Commit changes.");
			if (gatedInPhase.some(t => t.gateArtifact)) actions.push("Verify artifacts.");
			if (gatedInPhase.some(t => t.gateCmd || t.verifyCmd)) actions.push("Run verification commands.");
			lines.push(`\nPhase "${phase.name}" complete. ${actions.join(" ")}`);
		}
	}

	return lines.join("\n");
}

// =============================================================================
// Tool Class
// =============================================================================

export class TodoWriteTool implements AgentTool<typeof todoWriteSchema, TodoWriteToolDetails> {
	readonly name = "todo_write";
	readonly label = "Todo Write";
	readonly description: string;
	readonly parameters = todoWriteSchema;
	readonly concurrency = "exclusive";
	readonly strict = true;

	constructor(private readonly session: ToolSession) {
		this.description = renderPromptTemplate(todoWriteDescription);
	}

	async execute(
		_toolCallId: string,
		params: TodoWriteParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<TodoWriteToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<TodoWriteToolDetails>> {
		const previousPhases = this.session.getTodoPhases?.() ?? [];
		const current = fileFromPhases(previousPhases);
		const {
			file: updated,
			errors,
			completedPhaseIds,
			completedGatedTasks,
		} = applyOps(current, params.ops, previousPhases);
		this.session.setTodoPhases?.(updated.phases);
		// Notify dashboard bridge of todo state change
		this.session.eventBus?.emit("todo:change", { phases: updated.phases });
		const storage = this.session.getSessionFile() ? "session" : "memory";

		// Best-effort journal write to .local/!journal/todos/
		const sessionId = this.session.getSessionId?.() ?? "default";
		const projectRoot = this.session.cwd ?? getProjectDir();
		void writeJournal(projectRoot, sessionId, updated.phases);

		return {
			content: [
				{
					type: "text",
					text: formatSummary({ phases: updated.phases, errors, completedPhaseIds, completedGatedTasks }),
				},
			],
			details: { phases: updated.phases, storage },
		};
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface TodoWriteRenderArgs {
	ops?: Array<{ op: string }>;
}

/** Render compact gate badges after task content. */
function renderGateBadges(item: TodoItem, uiTheme: Theme): string {
	const badges: string[] = [];
	if (item.gateCommit) badges.push("[commit]");
	if (item.gateArtifact) badges.push(`[artifact: ${item.gateArtifact}]`);
	if (item.gateCmd) badges.push("[cmd]");
	if (item.gateLlm) badges.push("[llm]");
	if (item.verifyCmd) badges.push("[verify]");
	if (badges.length === 0) return "";
	return ` ${uiTheme.fg("dim", badges.join(" "))}`;
}

function formatTodoLine(item: TodoItem, uiTheme: Theme, prefix: string, allTasks?: TodoItem[]): string {
	const checkbox = uiTheme.checkbox;
	const badges = renderGateBadges(item, uiTheme);

	// Check blocked state (computed, not stored)
	if (allTasks && isTaskBlocked(item, allTasks)) {
		return uiTheme.fg("warning", `${prefix}${checkbox.unchecked} ${item.content} [blocked]`) + badges;
	}

	switch (item.status) {
		case "completed":
			return uiTheme.fg("success", `${prefix}${checkbox.checked} ${chalk.strikethrough(item.content)}`) + badges;
		case "in_progress": {
			const main = uiTheme.fg("accent", `${prefix}${checkbox.unchecked} ${item.content}`) + badges;
			if (!item.details) return main;
			const detailLines = item.details.split("\n").map(l => uiTheme.fg("dim", `${prefix}  ${l}`));
			return [main, ...detailLines].join("\n");
		}
		case "abandoned":
			return uiTheme.fg("error", `${prefix}${checkbox.unchecked} ${chalk.strikethrough(item.content)}`) + badges;
		default:
			return uiTheme.fg("dim", `${prefix}${checkbox.unchecked} ${item.content}`) + badges;
	}
}

export const todoWriteToolRenderer = {
	renderCall(args: TodoWriteRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const count = args.ops?.length ?? 0;
		const label = count === 1 ? (args.ops?.[0]?.op ?? "update") : `${count} ops`;
		const text = renderStatusLine({ icon: "pending", title: "Todo Write", meta: [label] }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: TodoWriteToolDetails },
		options: RenderResultOptions,
		uiTheme: Theme,
		_args?: TodoWriteRenderArgs,
	): Component {
		const phases = (result.details?.phases ?? []).filter(p => p.tasks.length > 0);
		const allTasks = phases.flatMap(p => p.tasks);
		const header = renderStatusLine(
			{ icon: "success", title: "Todo Write", meta: [`${allTasks.length} tasks`] },
			uiTheme,
		);
		if (allTasks.length === 0) {
			const fallback = result.content?.find(c => c.type === "text")?.text ?? "No todos";
			return new Text(`${header}\n${uiTheme.fg("dim", fallback)}`, 0, 0);
		}

		const { expanded } = options;
		const lines: string[] = [header];
		for (const phase of phases) {
			if (phases.length > 1) {
				lines.push(uiTheme.fg("accent", `  ${uiTheme.tree.hook} ${phase.name}`));
			}
			const treeLines = renderTreeList(
				{
					items: phase.tasks,
					expanded,
					maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
					itemType: "todo",
					renderItem: todo => formatTodoLine(todo, uiTheme, "", allTasks),
				},
				uiTheme,
			);
			lines.push(...treeLines);
		}
		return new Text(lines.join("\n"), 0, 0);
	},
	mergeCallAndResult: true,
};

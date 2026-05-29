/**
 * Task tool - Delegate tasks to specialized agents.
 *
 * Discovers agent definitions from:
 *   - Bundled agents (shipped with spell-coding-agent)
 *   - ~/.spell/agent/agents/*.md (user-level)
 *   - .spell/agents/*.md (project-level)
 *
 * Supports:
 *   - Single agent execution
 *   - Parallel execution with concurrency limits
 *   - Progress tracking via JSON events
 *   - Session artifacts for debugging
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import { $env, logger, Snowflake } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import type { ToolSession } from "..";
import { renderPromptTemplate } from "../config/prompt-templates";
import { loadSpellKdl, loadUserSpellKdl } from "../config/spell-kdl";
import type { Theme } from "../modes/theme/theme";
import { listPlanModeAllowedFolders } from "../plan-mode/allowed-folders";
import planModeSubagentPrompt from "../prompts/system/plan-mode-subagent.md" with { type: "text" };
import taskDescriptionTemplate from "../prompts/tools/task.md" with { type: "text" };
import taskSummaryTemplate from "../prompts/tools/task-summary.md" with { type: "text" };
import { isCodeToolSupportedPath } from "../tools/code-supported-files";
import { formatBytes, formatDuration } from "../tools/render-utils";
import {
	cloneTodoGroups,
	findTask,
	getNextTodoIds,
	hasRequiredGate,
	queueTodoMutation,
	type TodoDelegation,
	type TodoDelegationResult,
	type TodoGroup,
	type TodoItem,
	type TodoStatus,
	TodoWriteTool,
} from "../tools/todo-write";
import { resolveAgentEffectiveConfig } from "./agent-config-resolver";
// Import review tools for side effects (registers subagent tool handlers)
import "../tools/review";
import { generateCommitMessage } from "../utils/commit-message-generator";
import { type BatchGraph, type BatchImplicitBlocker, buildBatchGraph, scheduleBatch } from "./batch-scheduler";
import { discoverAgents, getAgent } from "./discovery";
import { type RuntimeVerificationOptions, runSubprocess } from "./executor";
import {
	type GateFailure,
	type GateVerificationResult,
	type TrackedBashExecution,
	verifyGates,
} from "./gate-verification";
import { resolveIsolationBackendForTaskExecution } from "./isolation-backend";
import { AgentOutputManager } from "./output-manager";
import { renderCall, renderResult } from "./render";
import { deriveAutoRosterPhaseNameFromContext, sanitizeTaskContent } from "./sanitize";
import { renderTemplate, resolvePredecessorResultsContext, resolveVerificationContext } from "./template";
import {
	type AgentDefinition,
	type AgentProgress,
	type SingleResult,
	type SubagentOutcome,
	type TaskItem,
	type TaskParams,
	type TaskSchema,
	type TaskToolDetails,
	taskSchema,
	taskSchemaNoIsolation,
} from "./types";
import {
	applyBaseline,
	applyNestedPatches,
	captureBaseline,
	captureDeltaPatch,
	cleanupFuseOverlay,
	cleanupProjfsOverlay,
	cleanupTaskBranches,
	cleanupWorktree,
	commitToBranch,
	ensureFuseOverlay,
	ensureProjfsOverlay,
	ensureWorktree,
	getRepoRoot,
	mergeTaskBranches,
	type WorktreeBaseline,
} from "./worktree";

const MAX_TASK_PARAMS_BYTES = 50 * 1024;

function createUsageTotals(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsageTotals(target: Usage, usage: Partial<Usage>): void {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const totalTokens = usage.totalTokens ?? input + output + cacheRead + cacheWrite;
	const cost =
		usage.cost ??
		({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		} satisfies Usage["cost"]);

	target.input += input;
	target.output += output;
	target.cacheRead += cacheRead;
	target.cacheWrite += cacheWrite;
	target.totalTokens += totalTokens;
	target.cost.input += cost.input;
	target.cost.output += cost.output;
	target.cost.cacheRead += cost.cacheRead;
	target.cost.cacheWrite += cost.cacheWrite;
	target.cost.total += cost.total;
}

const RESULT_INLINE_JSON_LIMIT = 5_000;

function stringifyStructuredResult(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	try {
		return JSON.stringify(value, null, 2);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function getResultSummaryText(
	result: Pick<SingleResult, "structuredResult" | "textPreview">,
	maxChars = 4_000,
): string | undefined {
	const text = result.textPreview?.trim() || stringifyStructuredResult(result.structuredResult);
	if (!text) return undefined;
	return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[truncated]` : text;
}

function getResultPreviewText(result: SingleResult): string {
	return (
		result.textPreview?.trim() ||
		stringifyStructuredResult(result.structuredResult) ||
		result.stderr.trim() ||
		"(no output)"
	);
}

function getResultInlineStructured(result: SingleResult): string | undefined {
	const text = stringifyStructuredResult(result.structuredResult);
	if (!text || text.length >= RESULT_INLINE_JSON_LIMIT) return undefined;
	return text;
}

function isSuccessfulOutcome(outcome: SubagentOutcome): boolean {
	return outcome === "completed" || outcome === "completed-empty";
}

function formatOutcomeLabel(result: SingleResult): string {
	if (result.outcome === "failed" && result.exitCode > 0) {
		return `failed (exit ${result.exitCode})`;
	}
	return result.outcome;
}

/**
 * Build assignment text from a sniper todo's content and details.
 * Returns undefined if the todo has neither content nor details.
 */
function buildSniperAssignment(todo: { content: string; details?: string }): string | undefined {
	if (!todo.content && !todo.details) return undefined;
	const parts: string[] = [`## Task: ${todo.content}`];
	if (todo.details) {
		parts.push("");
		parts.push(todo.details);
	}
	return parts.join("\n");
}

function formatImplicitBlockerReason(reason: string, cwd: string): string {
	const relative = path.isAbsolute(reason) ? path.relative(cwd, reason) || path.basename(reason) : reason;
	return relative.split(path.sep).join("/");
}

function buildImplicitBlockerNote(implicitBlockers: BatchImplicitBlocker[], cwd: string): string {
	if (implicitBlockers.length === 0) return "";
	const reorganizedTaskCount = new Set(implicitBlockers.flatMap(({ from, to }) => [from, to])).size;
	const taskLabel = reorganizedTaskCount === 1 ? "task" : "tasks";
	const blockers = implicitBlockers.map(
		({ to, from, reason }) => `${to}<-${from} (${formatImplicitBlockerReason(reason, cwd)})`,
	);
	return `Note: reorganized ${reorganizedTaskCount} ${taskLabel} into dependency chains due to filesDeps overlap. Implicit blockers: [${blockers.join(", ")}].\n\n`;
}

function withImplicitBlockers(details: TaskToolDetails, implicitBlockers: BatchImplicitBlocker[]): TaskToolDetails {
	return {
		...details,
		implicit_blockers: implicitBlockers.length > 0 ? implicitBlockers.map(blocker => ({ ...blocker })) : undefined,
	};
}

// Re-export types and utilities
export { loadBundledAgents as BUNDLED_AGENTS } from "./agents";
export { discoverCommands, expandCommand, getCommand } from "./commands";
export { discoverAgents, getAgent } from "./discovery";
export { AgentOutputManager } from "./output-manager";
export type { AgentDefinition, AgentProgress, SingleResult, TaskParams, TaskToolDetails } from "./types";
export { taskSchema } from "./types";

/**
 * Render the tool description from a cached agent list and current settings.
 */
function renderDescription(
	agents: AgentDefinition[],
	maxConcurrency: number,
	isolationEnabled: boolean,
	asyncEnabled: boolean,
	autoRosterEnabled: boolean,
	disabledAgents: string[],
): string {
	const filteredAgents = disabledAgents.length > 0 ? agents.filter(a => !disabledAgents.includes(a.name)) : agents;
	return renderPromptTemplate(taskDescriptionTemplate, {
		agents: filteredAgents,
		MAX_CONCURRENCY: maxConcurrency,
		isolationEnabled,
		asyncEnabled,
		autoRosterEnabled,
	});
}

export * from "./sanitize";
// ═══════════════════════════════════════════════════════════════════════════
// Tool Class
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Task tool - Delegate tasks to specialized agents.
 *
 * Requires async initialization to discover available agents.
 * Use `TaskTool.create(session)` to instantiate.
 */
export class TaskTool implements AgentTool<TaskSchema, TaskToolDetails, Theme> {
	readonly name = "task";
	readonly label = "Task";
	readonly strict = true;
	readonly parameters: TaskSchema;
	readonly renderCall = renderCall;
	readonly renderResult = renderResult;
	readonly #discoveredAgents: AgentDefinition[];
	readonly #blockedAgent: string | undefined;

	/** Dynamic description that reflects current disabled-agent settings */
	get description(): string {
		const disabledAgents = this.session.settings.get("task.disabledAgents") as string[];
		const maxConcurrency = this.session.settings.get("task.maxConcurrency");
		const isolationMode = this.session.settings.get("task.isolation.mode");
		const autoRosterEnabled =
			this.session.settings.get("todo.enabled") && this.session.settings.get("task.autoRoster");
		return renderDescription(
			this.#discoveredAgents,
			maxConcurrency,
			isolationMode !== "none",
			this.session.settings.get("async.enabled"),
			autoRosterEnabled,
			disabledAgents,
		);
	}
	private constructor(
		private readonly session: ToolSession,
		discoveredAgents: AgentDefinition[],
		isolationEnabled: boolean,
	) {
		this.parameters = isolationEnabled ? taskSchema : taskSchemaNoIsolation;
		this.#blockedAgent = $env.PI_BLOCKED_AGENT;
		this.#discoveredAgents = discoveredAgents;
	}

	/**
	 * Create a TaskTool instance with async agent discovery.
	 */
	static async create(session: ToolSession): Promise<TaskTool> {
		const isolationMode = session.settings.get("task.isolation.mode");
		const { agents } = await discoverAgents(session.cwd);
		return new TaskTool(session, agents, isolationMode !== "none");
	}

	/** Augment each task's assignment with todoRef-derived execution context. */
	async #injectVerificationContext(tasks: TaskItem[]): Promise<TaskItem[]> {
		const groups = this.session.getTodoGroups?.();
		if (!groups || groups.length === 0) return tasks;
		const activePolicies = this.session.getResolvedTaskPolicies?.() ?? [];
		return tasks.map(task => {
			if (!task.todoRef) return task;
			const blocks = [
				resolvePredecessorResultsContext(task.todoRef, groups),
				resolveVerificationContext(task.todoRef, groups, activePolicies),
			].filter((block): block is string => Boolean(block));
			if (blocks.length === 0) return task;
			return { ...task, assignment: `${(task.assignment ?? "").trim()}\n\n${blocks.join("\n\n")}` };
		});
	}

	/** Resolve todoRef-derived assignments for tasks missing explicit assignment. */
	#resolveTodoRefAssignments(tasks: TaskItem[]): TaskItem[] {
		const groups = this.session.getTodoGroups?.();
		if (!groups || groups.length === 0) return tasks;
		let changed = false;
		const resolvedTasks = tasks.map(task => {
			if (task.assignment?.trim() || !task.todoRef) return task;
			const todo = findTask(groups, task.todoRef);
			if (!todo) return task;
			const assignment = buildSniperAssignment(todo);
			if (!assignment) return task;
			changed = true;
			return { ...task, assignment };
		});
		return changed ? resolvedTasks : tasks;
	}

	#validateTaskBatch(tasks: TaskItem[]): string | undefined {
		const missingTaskIndexes: number[] = [];
		const idIndexes = new Map<string, number[]>();
		for (let index = 0; index < tasks.length; index++) {
			const id = tasks[index]?.id;
			if (typeof id !== "string" || id.trim() === "") {
				missingTaskIndexes.push(index);
				continue;
			}
			const normalizedId = id.toLowerCase();
			const indexes = idIndexes.get(normalizedId);
			if (indexes) {
				indexes.push(index);
			} else {
				idIndexes.set(normalizedId, [index]);
			}
		}
		const problems: string[] = [];
		if (missingTaskIndexes.length > 0) {
			problems.push(`Missing task ids at indexes: ${missingTaskIndexes.join(", ")}`);
		}
		const duplicateIds: Array<{ id: string; indexes: number[] }> = [];
		for (const [normalizedId, indexes] of idIndexes.entries()) {
			if (indexes.length > 1) {
				duplicateIds.push({
					id: tasks[indexes[0]]?.id ?? normalizedId,
					indexes,
				});
			}
		}
		if (duplicateIds.length > 0) {
			const details = duplicateIds.map(entry => `${entry.id} (indexes ${entry.indexes.join(", ")})`).join("; ");
			problems.push(`Duplicate task ids detected (case-insensitive): ${details}`);
		}
		if (problems.length > 0) return problems.join(". ");
		try {
			buildBatchGraph(tasks.map(task => ({ id: task.id, blockers: task.blockers, filesDeps: task.filesDeps })));
		} catch (error) {
			problems.push(error instanceof Error ? error.message : String(error));
		}
		const missingAssignmentIndexes = tasks.flatMap((task, index) =>
			!task.assignment?.trim() && !task.todoRef ? [index] : [],
		);
		if (missingAssignmentIndexes.length > 0) {
			problems.push(`Tasks at indexes ${missingAssignmentIndexes.join(", ")} have no assignment and no todoRef`);
		}
		return problems.length > 0 ? problems.join(". ") : undefined;
	}

	#validateTaskPayloadSize(params: TaskParams): string | undefined {
		const payloadBytes = Buffer.byteLength(JSON.stringify(params), "utf-8");
		if (payloadBytes <= MAX_TASK_PARAMS_BYTES) return undefined;
		return `Task payload size ${formatBytes(payloadBytes)} exceeds ${formatBytes(MAX_TASK_PARAMS_BYTES)} limit. Keep assignments lean and move shared context out of per-task payloads.`;
	}

	#shouldAutoCreateRoster(agent: AgentDefinition | undefined, tasks: TaskItem[]): boolean {
		if (!agent || tasks.length === 0) return false;
		if (!this.session.getTodoGroups || !this.session.setTodoGroups) return false;
		if ((this.session.taskDepth ?? 0) > 0) return false;
		if (!this.session.settings.get("todo.enabled")) return false;
		if (!this.session.settings.get("task.autoRoster")) return false;
		if (agent.roster === false) return false;
		return true;
	}

	#deriveAutoRosterPhaseName(params: TaskParams): string {
		return deriveAutoRosterPhaseNameFromContext(params.context, params.phase);
	}

	async #autoCreateTodoRefs(params: TaskParams, agent: AgentDefinition | undefined): Promise<TaskItem[]> {
		const taskItems = params.tasks ?? [];
		if (!this.#shouldAutoCreateRoster(agent, taskItems)) return taskItems;
		const tasksToCreate = taskItems.filter(task => !task.todoRef);
		if (tasksToCreate.length === 0) return taskItems;
		const agentName = agent?.name ?? params.agent;
		const phaseName = this.#deriveAutoRosterPhaseName(params);
		const createdTodoRefs = await queueTodoMutation(this.session, async () => {
			const groups = cloneTodoGroups(this.session.getTodoGroups?.() ?? []);
			const { nextTaskId } = getNextTodoIds(groups);
			const predictedTodoRefByTaskId = new Map<string, string>();
			for (const task of taskItems) {
				if (task.todoRef) predictedTodoRefByTaskId.set(task.id, task.todoRef);
			}
			for (const [index, task] of tasksToCreate.entries()) {
				predictedTodoRefByTaskId.set(task.id, `task-${nextTaskId + index}`);
			}
			const result = await new TodoWriteTool(this.session).execute("task-auto-roster-create", {
				ops: [
					{
						op: "add_group",
						name: phaseName,
						tasks: tasksToCreate.map(task => {
							const blockerTodoRefs = (task.blockers ?? [])
								.map(blockerId => predictedTodoRefByTaskId.get(blockerId))
								.filter((blockerId): blockerId is string => blockerId !== undefined);
							if ((task.blockers?.length ?? 0) !== blockerTodoRefs.length) {
								logger.warn("task auto-roster blocker mapping incomplete", {
									taskId: task.id,
									blockers: task.blockers,
								});
							}
							return {
								content: sanitizeTaskContent(task.description, task.id),
								blockers: blockerTodoRefs.length > 0 ? blockerTodoRefs : undefined,
								delegation: { sessionId: "pending", agent: agentName },
								layer: task.layer,
							};
						}),
					},
				],
			});
			const summary = result.content.find(part => part.type === "text")?.text ?? "";
			if (summary.startsWith("Errors:")) {
				logger.warn("task auto-roster creation reported todo_write errors", { summary });
			}
			const createdGroup = result.details?.groups.at(-1);
			const mapping = new Map<string, string>();
			if (!createdGroup) {
				logger.warn("task auto-roster creation missing created group", { phaseName });
				return mapping;
			}
			for (let index = 0; index < tasksToCreate.length; index++) {
				const todo = createdGroup.tasks[index];
				const task = tasksToCreate[index];
				if (!todo || !task) {
					logger.warn("task auto-roster creation missing mapped todo", { phaseName, index });
					continue;
				}
				mapping.set(task.id, todo.id);
			}
			return mapping;
		});
		if (!createdTodoRefs || createdTodoRefs.size === 0) return taskItems;
		return taskItems.map(task => {
			if (task.todoRef) return task;
			const todoRef = createdTodoRefs.get(task.id);
			return todoRef ? { ...task, todoRef } : task;
		});
	}

	#buildTodoDelegation(agent: string, sessionId?: string, transcriptPath?: string): TodoDelegation | undefined {
		if (!sessionId) return undefined;
		return { agent, sessionId, transcriptPath };
	}

	#buildTodoResultSummary(
		result: SingleResult,
		verification?: TodoDelegationResult["verification"],
	): TodoDelegationResult {
		return {
			output: getResultSummaryText(result),
			error: result.error,
			outputPath: result.outputPath,
			verification,
		};
	}

	#findTodoForRef(todoRef: string | undefined): TodoItem | undefined {
		if (!todoRef) return undefined;
		const groups = this.session.getTodoGroups?.();
		if (!groups) return undefined;
		return findTask(groups, todoRef);
	}

	async #writeVerificationArtifact(
		todo: TodoItem,
		status: TodoStatus,
		verification: NonNullable<TodoDelegationResult["verification"]>,
		result: SingleResult,
		isolationContext?: { isolationDir: string; baselineHeadCommit: string },
	): Promise<string | undefined> {
		if (!todo.verificationArtifact) return undefined;
		const baseDir = isolationContext?.isolationDir ?? this.session.cwd;
		const artifactPath = path.isAbsolute(todo.verificationArtifact)
			? todo.verificationArtifact
			: path.resolve(baseDir, todo.verificationArtifact);
		await Bun.write(
			artifactPath,
			JSON.stringify(
				{
					status,
					verification,
					outputPath: result.outputPath,
					error: result.error,
				},
				null,
				2,
			),
		);
		return artifactPath;
	}

	async #buildDelegatedVerificationSummary(
		todo: TodoItem | undefined,
		status: TodoStatus,
		gateFailures: GateFailure[] | undefined,
		result: SingleResult,
		isolationContext?: { isolationDir: string; baselineHeadCommit: string },
	): Promise<TodoDelegationResult["verification"] | undefined> {
		if (!todo || (!hasRequiredGate(todo) && !todo.verificationArtifact)) return undefined;
		const verification: NonNullable<TodoDelegationResult["verification"]> = {
			status: status === "completed" ? "passed" : "failed",
			gateCommit: todo.gateCommit,
			gateArtifact: todo.gateArtifact,
			gateCmd: todo.gateCmd,
			failures: gateFailures ? [...gateFailures] : undefined,
		};
		const artifactPath = await this.#writeVerificationArtifact(todo, status, verification, result, isolationContext);
		if (artifactPath) verification.artifactPath = artifactPath;
		return verification;
	}

	#buildRuntimeVerificationOptions(
		todoRef: string | undefined,
		isolationContext?: { isolationDir: string; baselineHeadCommit: string },
	): RuntimeVerificationOptions | undefined {
		if (!todoRef) return undefined;
		const groups = this.session.getTodoGroups?.();
		if (!groups) return undefined;
		const todo = findTask(groups, todoRef);
		if (!todo || !hasRequiredGate(todo)) return undefined;
		return {
			gateCmd: todo.gateCmd,
			gateCommit: todo.gateCommit,
			gateArtifact: todo.gateArtifact,
			baselineHeadCommit: isolationContext?.baselineHeadCommit,
		};
	}

	async #queueTodoRefMutation<T>(action: () => Promise<T>): Promise<T | undefined> {
		return await queueTodoMutation(this.session, async () => {
			try {
				return await action();
			} catch (error) {
				logger.error("task todoRef lifecycle update failed", {
					error: error instanceof Error ? error.message : String(error),
				});
				return undefined;
			}
		});
	}

	async #finalizeSkippedTodoRef(
		task: TaskItem,
		agent: string,
		agentSource: SingleResult["agentSource"],
		errorMessage: string,
		aborted: boolean = false,
	): Promise<void> {
		if (!task.todoRef) return;
		await this.#finalizeTodoRef(task, {
			index: 0,
			id: task.id,
			agent,
			agentSource,
			sessionId: "skipped",
			task: task.description,
			assignment: task.assignment,
			description: task.description,
			exitCode: 1,
			outcome: aborted ? "aborted" : "failed",
			stderr: errorMessage,
			resultUri: `agent://${task.id}`,
			textPreview: errorMessage,
			durationMs: 0,
			tokens: 0,
			error: errorMessage,
			aborted: aborted || undefined,
			abortReason: aborted ? errorMessage : undefined,
		});
	}

	#mergeTodoRefDelegation(todoRef: string, patch: Partial<TodoDelegation>): void {
		const groups = this.session.getTodoGroups?.();
		if (!groups) return;
		const nextGroups = cloneTodoGroups(groups);
		const todo = findTask(nextGroups, todoRef);
		if (!todo) {
			logger.warn("task todoRef delegation update skipped: todo not found", { todoRef });
			return;
		}
		const nextChildGroups = patch.childGroups
			? cloneTodoGroups(patch.childGroups).map(group => ({
					...group,
					tasks: group.tasks.map(child => ({
						...child,
						delegation: child.delegation ? { ...child.delegation, childGroups: undefined } : child.delegation,
					})),
				}))
			: todo.delegation?.childGroups;
		const sessionId = patch.sessionId ?? todo.delegation?.sessionId;
		if (!sessionId) return;
		todo.delegation = {
			...todo.delegation,
			...patch,
			sessionId,
			childGroups: nextChildGroups,
		};
		this.session.setTodoGroups?.(nextGroups);
		this.session.eventBus?.emit("todo:change", { groups: nextGroups });
	}

	async #applyTodoRefStatus(todoRef: string, status: TodoStatus, verified?: boolean): Promise<void> {
		const result = await new TodoWriteTool(this.session).execute("task-todo-ref", {
			ops: [{ op: "update", id: todoRef, status, verified }],
		});
		const summary = result.content.find(part => part.type === "text")?.text ?? "";
		if (summary.startsWith("Errors:")) {
			logger.warn("task todoRef lifecycle update reported todo_write errors", { todoRef, status, summary });
		}
	}

	#markTodoRefStarted(task: TaskItem, progress: AgentProgress, startedTodoRefs: Set<string>): void {
		if (!task.todoRef || startedTodoRefs.has(task.id) || progress.status !== "running") return;
		const delegation = this.#buildTodoDelegation(progress.agent, progress.sessionId, progress.transcriptPath);
		if (!delegation) return;
		startedTodoRefs.add(task.id);
		void this.#queueTodoRefMutation(async () => {
			this.#mergeTodoRefDelegation(task.todoRef!, delegation);
			await this.#applyTodoRefStatus(task.todoRef!, "in_progress");
		});
	}

	#syncTodoRefChildPhases(task: TaskItem, childGroups: TodoGroup[] | undefined): void {
		if (!task.todoRef || childGroups === undefined) return;
		void this.#queueTodoRefMutation(async () => {
			this.#mergeTodoRefDelegation(task.todoRef!, { childGroups });
		});
	}

	async #finalizeTodoRef(
		task: TaskItem,
		result: SingleResult,
		isolationContext?: { isolationDir: string; baselineHeadCommit: string },
	): Promise<void> {
		if (!task.todoRef) return;
		const delegation = this.#buildTodoDelegation(result.agent, result.sessionId, result.transcriptUri);
		const todo = this.#findTodoForRef(task.todoRef);

		let status: TodoStatus;
		let gateFailures: GateFailure[] | undefined;
		// Track whether gate verification ran and passed, so we can bypass two-phase verification
		let gatesVerified = false;

		if (isSuccessfulOutcome(result.outcome) && result.exitCode === 0 && !result.error) {
			const gateResult = await this.#verifyTaskGates(task.todoRef, result, isolationContext);
			const childGateFailures = result.todoGroups
				? await this.#verifyChildTodoGates(result.todoGroups, result, isolationContext)
				: undefined;
			if (gateResult && !gateResult.passed) {
				status = "gate_failed";
				gateFailures = gateResult.failures;
			} else if (childGateFailures && childGateFailures.length > 0) {
				status = "gate_failed";
				gateFailures = childGateFailures;
			} else {
				status = "completed";
				// If gate verification ran and passed, mark as verified
				gatesVerified = gateResult !== undefined;
			}
		} else {
			if (result.outcome === "gate_failed") {
				status = "gate_failed";
				gateFailures = result.gateFailures;
			} else {
				status = "failed";
			}
		}

		const verificationSummary = await this.#buildDelegatedVerificationSummary(
			todo,
			status,
			gateFailures,
			result,
			isolationContext,
		);
		const resultSummary = this.#buildTodoResultSummary(result, verificationSummary);
		if (gateFailures?.length) {
			resultSummary.gateFailures = gateFailures;
		}

		await this.#queueTodoRefMutation(async () => {
			if (delegation) this.#mergeTodoRefDelegation(task.todoRef!, delegation);
			if (result.todoGroups !== undefined) {
				this.#mergeTodoRefDelegation(task.todoRef!, { childGroups: result.todoGroups });
			}
			this.#mergeTodoRefDelegation(task.todoRef!, { result: resultSummary });
			await this.#applyTodoRefStatus(task.todoRef!, status, gatesVerified || undefined);
		});
	}

	async #verifyTaskGates(
		todoRef: string,
		result: SingleResult,
		isolationContext?: { isolationDir: string; baselineHeadCommit: string },
	): Promise<GateVerificationResult | undefined> {
		const groups = this.session.getTodoGroups?.();
		if (!groups) return undefined;
		const todo = findTask(groups, todoRef);
		if (!todo) return undefined;
		if (!hasRequiredGate(todo)) return undefined;

		const executions = (result.extractedToolData?.bash as TrackedBashExecution[] | undefined) ?? [];
		return verifyGates({
			gateCmd: todo.gateCmd,
			gateCommit: todo.gateCommit,
			gateArtifact: todo.gateArtifact,
			executions,
			cwd: this.session.cwd,
			// When an isolation worktree is active, resolve artifact paths and gateCommit
			// against the worktree rather than the parent session cwd / bash history.
			worktreeDir: isolationContext?.isolationDir,
			baselineHeadCommit: isolationContext?.baselineHeadCommit,
		});
	}

	async #verifyChildTodoGates(
		childGroups: TodoGroup[],
		result: SingleResult,
		isolationContext?: { isolationDir: string; baselineHeadCommit: string },
	): Promise<Array<GateFailure & { taskId: string }> | undefined> {
		const executions = (result.extractedToolData?.bash as TrackedBashExecution[] | undefined) ?? [];
		const failures: Array<GateFailure & { taskId: string }> = [];
		for (const group of childGroups) {
			for (const child of group.tasks) {
				if (child.status === "gate_failed") {
					for (const failure of child.delegation?.result?.gateFailures ?? []) {
						failures.push({
							taskId: failure.taskId ?? child.id,
							gate: failure.gate as GateFailure["gate"],
							expected: failure.expected,
							detail: failure.detail,
						});
					}
					continue;
				}
				if (child.status !== "completed" || !hasRequiredGate(child)) continue;
				const gateResult = await verifyGates({
					gateCmd: child.gateCmd,
					gateCommit: child.gateCommit,
					gateArtifact: child.gateArtifact,
					executions,
					cwd: this.session.cwd,
					worktreeDir: isolationContext?.isolationDir,
					baselineHeadCommit: isolationContext?.baselineHeadCommit,
				});
				if (!gateResult.passed) {
					failures.push(...gateResult.failures.map(failure => ({ taskId: child.id, ...failure })));
				}
			}
		}
		return failures.length > 0 ? failures : undefined;
	}

	async execute(
		_toolCallId: string,
		params: TaskParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
	): Promise<AgentToolResult<TaskToolDetails>> {
		const asyncEnabled = this.session.settings.get("async.enabled");
		const tasks = params.tasks ?? [];
		const resolvedTasks = this.#resolveTodoRefAssignments(tasks);
		const resolvedParams = resolvedTasks === tasks ? params : { ...params, tasks: resolvedTasks };
		const rawTasks = resolvedParams.tasks ?? [];
		const taskPayloadValidationError = this.#validateTaskPayloadSize(params);
		if (taskPayloadValidationError) {
			return {
				content: [{ type: "text", text: `Invalid tasks: ${taskPayloadValidationError}` }],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};
		}
		const selectedAgent = this.#discoveredAgents.find(agent => agent.name === params.agent);
		if (selectedAgent?.scopeRestricted) {
			const missingFilesDeps = rawTasks
				.filter(task => !task.filesDeps || task.filesDeps.length === 0)
				.map(task => task.id);
			if (missingFilesDeps.length > 0) {
				return {
					content: [
						{
							type: "text",
							text: `QUICK_TASK_MISSING_FILESDEPS: ${missingFilesDeps.join(", ")}`,
						},
					],
					details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
				};
			}
		}
		const resolvedFilesDeps = rawTasks.map(task => ({
			...task,
			filesDeps: task.filesDeps?.map(file => {
				const resolved = path.resolve(this.session.cwd, file);
				return file.endsWith("/") || file.endsWith(path.sep) ? `${resolved}${path.sep}` : resolved;
			}),
		}));
		const rawTasksForDispatch = resolvedFilesDeps;
		const taskValidationError = this.#validateTaskBatch(rawTasks);
		if (taskValidationError) {
			return {
				content: [{ type: "text", text: `Invalid tasks: ${taskValidationError}` }],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};
		}
		if (asyncEnabled && selectedAgent?.blocking !== true && !this.session.asyncJobManager) {
			return {
				content: [{ type: "text", text: "Async execution is enabled but no async job manager is available." }],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};
		}
		const preDispatchParams = { ...resolvedParams, tasks: rawTasksForDispatch };
		const preparedTasks = signal?.aborted
			? rawTasksForDispatch
			: await this.#autoCreateTodoRefs(preDispatchParams, selectedAgent);
		const dispatchParams =
			preparedTasks === preDispatchParams.tasks ? preDispatchParams : { ...preDispatchParams, tasks: preparedTasks };
		if (!asyncEnabled || selectedAgent?.blocking === true) {
			return this.#executeSync(_toolCallId, dispatchParams, signal, onUpdate);
		}

		const manager = this.session.asyncJobManager!;

		const taskItems = dispatchParams.tasks ?? [];
		if (taskItems.length === 0) {
			return this.#executeSync(_toolCallId, dispatchParams, signal, onUpdate);
		}

		const outputManager =
			this.session.agentOutputManager ?? new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
		const uniqueIds = await outputManager.allocateBatch(taskItems.map(t => t.id));
		const fallbackAgentSource = selectedAgent?.source ?? "bundled";
		const augmentedTasks = await this.#injectVerificationContext(taskItems);
		const taskExecutions = augmentedTasks.map((taskItem, index) => ({
			logicalId: taskItem.id,
			executionId: uniqueIds[index] ?? taskItem.id,
			blockers: taskItem.blockers,
			filesDeps: taskItem.filesDeps,
			...renderTemplate(params.context, taskItem),
		}));
		let batchGraph: BatchGraph;
		try {
			batchGraph = buildBatchGraph(
				taskExecutions.map(taskExecution => ({
					id: taskExecution.logicalId,
					blockers: taskExecution.blockers,
					filesDeps: taskExecution.filesDeps,
				})),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text", text: `Invalid task blockers: ${message}` }],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};
		}
		const implicitBlockerNote = buildImplicitBlockerNote(batchGraph.implicitBlockers, this.session.cwd);
		const progressByTaskId = new Map<string, AgentProgress>();
		for (let index = 0; index < taskExecutions.length; index++) {
			const taskExecution = taskExecutions[index];
			progressByTaskId.set(taskExecution.logicalId, {
				index,
				id: taskExecution.logicalId,
				agent: params.agent,
				agentSource: fallbackAgentSource,
				status: "pending",
				task: taskExecution.task,
				assignment: taskExecution.assignment,
				description: taskExecution.description,
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				tokens: 0,
				durationMs: 0,
			});
		}

		const startedJobs: Array<{ jobId: string; taskId: string }> = [];
		const failedSchedules: string[] = [];
		const completedTaskIds = new Set<string>();
		const runningTaskIds = new Set<string>();
		const remainingBlockers = new Map<string, number>();
		for (const taskExecution of taskExecutions) {
			remainingBlockers.set(
				taskExecution.logicalId,
				batchGraph.blockersById.get(taskExecution.logicalId)?.length ?? 0,
			);
		}
		const readyQueue = batchGraph.order.filter(id => (batchGraph.blockersById.get(id)?.length ?? 0) === 0);
		let completedJobs = 0;
		let failedJobs = 0;

		const getProgressSnapshot = (): AgentProgress[] => {
			return Array.from(progressByTaskId.values())
				.sort((a, b) => a.index - b.index)
				.map(progress => structuredClone(progress));
		};

		const buildAsyncDetails = (state: "running" | "completed" | "failed", jobId: string): TaskToolDetails =>
			withImplicitBlockers(
				{
					projectAgentsDir: null,
					results: [],
					totalDurationMs: 0,
					progress: getProgressSnapshot(),
					async: { state, jobId, type: "task" },
				},
				batchGraph.implicitBlockers,
			);

		const syncAsyncProgress = (target: AgentProgress, source: AgentProgress): void => {
			const index = target.index;
			const logicalId = target.id;
			Object.assign(target, structuredClone(source), { index, id: logicalId });
		};

		const emitAsyncUpdate = (state: "running" | "completed" | "failed", text: string): void => {
			const primaryJobId = startedJobs[0]?.jobId ?? "task";
			onUpdate?.({
				content: [{ type: "text", text: `${implicitBlockerNote}${text}` }],
				details: buildAsyncDetails(state, primaryJobId),
			});
		};

		const markTaskTerminal = (logicalId: string, status: AgentProgress["status"], errorMessage?: string): boolean => {
			if (completedTaskIds.has(logicalId)) return false;
			completedTaskIds.add(logicalId);
			completedJobs += 1;
			if (status !== "completed") {
				failedJobs += 1;
			}
			const progress = progressByTaskId.get(logicalId);
			if (progress) {
				progress.status = status;
				progress.retry = undefined;
				if (errorMessage) {
					progress.recentOutput = [errorMessage];
				}
			}
			return true;
		};

		const failDependents = (failedPredecessorId: string): void => {
			const queue = [...(batchGraph.dependentsById.get(failedPredecessorId) ?? [])];
			const seen = new Set<string>();
			while (queue.length > 0) {
				const dependentId = queue.shift();
				if (!dependentId || seen.has(dependentId)) continue;
				seen.add(dependentId);
				if (runningTaskIds.has(dependentId)) continue;
				const errorMessage = `Predecessor ${failedPredecessorId} failed`;
				if (markTaskTerminal(dependentId, "failed", errorMessage)) {
					const dependentIndex = batchGraph.indexById.get(dependentId);
					if (dependentIndex !== undefined) {
						void this.#finalizeSkippedTodoRef(
							augmentedTasks[dependentIndex]!,
							params.agent,
							fallbackAgentSource,
							errorMessage,
						);
					}
					queue.push(...(batchGraph.dependentsById.get(dependentId) ?? []));
				}
			}
		};

		const abortPendingTasks = (): void => {
			for (const taskExecution of taskExecutions) {
				if (runningTaskIds.has(taskExecution.logicalId)) continue;
				if (markTaskTerminal(taskExecution.logicalId, "aborted", "Cancelled before start")) {
					const taskIndex = batchGraph.indexById.get(taskExecution.logicalId);
					if (taskIndex !== undefined) {
						void this.#finalizeSkippedTodoRef(
							augmentedTasks[taskIndex]!,
							params.agent,
							fallbackAgentSource,
							"Cancelled before start",
							true,
						);
					}
				}
			}
		};

		const maxConcurrency = this.session.settings.get("task.maxConcurrency");
		const asyncStaggerMs = this.session.settings.get("task.cacheStaggerMs") ?? 800;
		let asyncLaunchCount = 0;
		const emitCompletionIfDone = (): void => {
			if (completedJobs !== taskItems.length) return;
			const failed = failedJobs > 0;
			emitAsyncUpdate(
				failed ? "failed" : "completed",
				failed
					? `Background task batch complete with failures: ${failedJobs} failed.`
					: `Background task batch complete: ${completedJobs}/${taskItems.length} finished.`,
			);
		};

		const scheduleReadyTasks = (): void => {
			if (signal?.aborted) {
				abortPendingTasks();
				emitCompletionIfDone();
				return;
			}
			while (runningTaskIds.size < maxConcurrency && readyQueue.length > 0) {
				const logicalId = readyQueue.shift();
				if (!logicalId || completedTaskIds.has(logicalId) || runningTaskIds.has(logicalId)) continue;
				const taskIndex = batchGraph.indexById.get(logicalId);
				if (taskIndex === undefined) {
					markTaskTerminal(logicalId, "failed", `Task ${logicalId} missing from async batch graph`);
					continue;
				}
				const taskExecution = taskExecutions[taskIndex]!;
				const taskItem = augmentedTasks[taskIndex]!;
				const singleParams: TaskParams = {
					...dispatchParams,
					tasks: [{ ...taskItem, blockers: undefined }],
				};
				const label = taskExecution.executionId;
				try {
					runningTaskIds.add(logicalId);
					const jobId = manager.register(
						"task",
						label,
						async ({ signal: runSignal, reportProgress }) => {
							// Stagger sibling launches for prompt cache warming
							const myLaunchIndex = asyncLaunchCount++;
							if (asyncStaggerMs > 0 && myLaunchIndex > 0) {
								await Bun.sleep(asyncStaggerMs * myLaunchIndex);
								if (runSignal.aborted) throw new Error("Aborted during stagger delay");
							}
							const startedAt = Date.now();
							const progress = progressByTaskId.get(logicalId);
							if (progress) {
								progress.status = "running";
							}
							await reportProgress(
								`Running background task ${logicalId} (batch ${startedJobs[0]?.jobId ?? label})...`,
								buildAsyncDetails("running", startedJobs[0]?.jobId ?? label) as unknown as Record<
									string,
									unknown
								>,
							);
							try {
								const result = await this.#executeSync(
									_toolCallId,
									singleParams,
									runSignal,
									update => {
										const subProgress = update.details?.progress?.[0];
										if (!subProgress || !progress || subProgress.status === "pending") return;
										syncAsyncProgress(progress, subProgress);
										void reportProgress(
											`Running background task ${logicalId} (batch ${startedJobs[0]?.jobId ?? label})...`,
											buildAsyncDetails("running", startedJobs[0]?.jobId ?? label) as unknown as Record<
												string,
												unknown
											>,
										);
									},
									[label],
								);
								const finalText = result.content.find(part => part.type === "text")?.text ?? "(no output)";
								const singleResult = result.details?.results[0];
								if (progress) {
									progress.durationMs = singleResult?.durationMs ?? Math.max(0, Date.now() - startedAt);
									progress.tokens = singleResult?.tokens ?? 0;
									progress.extractedToolData = singleResult?.extractedToolData;
									progress.retry = undefined;
								}
								if (!singleResult) {
									markTaskTerminal(logicalId, "failed", "Background task finished without a result");
									failDependents(logicalId);
								} else if (singleResult.aborted ?? false) {
									markTaskTerminal(
										logicalId,
										"aborted",
										singleResult.abortReason ?? singleResult.error ?? "Aborted",
									);
								} else if (singleResult.exitCode === 0) {
									markTaskTerminal(logicalId, "completed");
									if (!signal?.aborted) {
										for (const dependentId of batchGraph.dependentsById.get(logicalId) ?? []) {
											if (completedTaskIds.has(dependentId)) continue;
											const nextCount = (remainingBlockers.get(dependentId) ?? 0) - 1;
											remainingBlockers.set(dependentId, nextCount);
											if (nextCount === 0) {
												readyQueue.push(dependentId);
											}
										}
									}
								} else {
									markTaskTerminal(
										logicalId,
										"failed",
										singleResult.error ??
											singleResult.stderr ??
											`Task failed with exit ${singleResult.exitCode}`,
									);
									failDependents(logicalId);
								}
								runningTaskIds.delete(logicalId);
								if (signal?.aborted) {
									abortPendingTasks();
								}
								scheduleReadyTasks();
								const remaining = taskItems.length - completedJobs;
								const isDone = remaining === 0;
								await reportProgress(
									isDone
										? failedJobs > 0
											? `Background task batch complete with failures: ${failedJobs} failed.`
											: `Background task batch complete: ${completedJobs}/${taskItems.length} finished.`
										: `Background task batch progress: ${completedJobs}/${taskItems.length} finished (${remaining} remaining).`,
									buildAsyncDetails(
										isDone ? (failedJobs > 0 ? "failed" : "completed") : "running",
										startedJobs[0]?.jobId ?? label,
									) as unknown as Record<string, unknown>,
								);
								emitCompletionIfDone();
								return finalText;
							} catch (error) {
								runningTaskIds.delete(logicalId);
								markTaskTerminal(
									logicalId,
									signal?.aborted ? "aborted" : "failed",
									error instanceof Error ? error.message : String(error),
								);
								if (!signal?.aborted) {
									failDependents(logicalId);
								} else {
									abortPendingTasks();
								}
								scheduleReadyTasks();
								emitCompletionIfDone();
								throw error;
							}
						},
						{
							id: label,
							onProgress: (text, details) => {
								const progressDetails =
									(details as TaskToolDetails | undefined) ??
									buildAsyncDetails("running", startedJobs[0]?.jobId ?? label);
								onUpdate?.({ content: [{ type: "text", text }], details: progressDetails });
							},
						},
					);
					startedJobs.push({ jobId, taskId: logicalId });
				} catch (error) {
					runningTaskIds.delete(logicalId);
					const message = error instanceof Error ? error.message : String(error);
					failedSchedules.push(`${logicalId}: ${message}`);
					markTaskTerminal(logicalId, "failed", message);
					void this.#finalizeSkippedTodoRef(taskItem, params.agent, fallbackAgentSource, message);
					failDependents(logicalId);
				}
			}
			emitCompletionIfDone();
		};

		scheduleReadyTasks();

		// Compute queued tasks for transparency in dispatch text
		const startedTaskIds = new Set(startedJobs.map(j => j.taskId));
		const queuedTasks = taskExecutions.filter(
			t => !startedTaskIds.has(t.logicalId) && !completedTaskIds.has(t.logicalId),
		);
		const queuedCount = queuedTasks.length;
		const queuedChains = queuedTasks.map(t => {
			const blockers = batchGraph.blockersById.get(t.logicalId) ?? [];
			return `${t.logicalId}<-${blockers.join(",")}`;
		});

		if (startedJobs.length === 0) {
			const failureText =
				completedJobs === taskItems.length
					? signal?.aborted
						? "Background task batch cancelled before scheduling."
						: failedSchedules.length > 0
							? `Failed to start background task jobs: ${failedSchedules.join("; ")}`
							: "No background task jobs were started."
					: `Failed to start background task jobs: ${failedSchedules.join("; ")}`;
			return {
				content: [{ type: "text", text: `${implicitBlockerNote}${failureText}` }],
				details: withImplicitBlockers(
					{ projectAgentsDir: null, results: [], totalDurationMs: 0, progress: getProgressSnapshot() },
					batchGraph.implicitBlockers,
				),
			};
		}

		emitAsyncUpdate(
			"running",
			`Launching ${startedJobs.length} background ${startedJobs.length === 1 ? "task" : "tasks"} with DAG scheduling...`,
		);

		const scheduleFailureSummary =
			failedSchedules.length > 0
				? ` Failed to schedule ${failedSchedules.length} task${failedSchedules.length === 1 ? "" : "s"}.`
				: "";

		return {
			content: [
				{
					type: "text",
					text: `${implicitBlockerNote}Started ${startedJobs.length} background task job${startedJobs.length === 1 ? "" : "s"} using ${params.agent}${
						queuedCount > 0
							? ` (${queuedCount} queued behind blocker${queuedCount === 1 ? "" : "s"}: [${queuedChains.join("; ")}])`
							: ""
					}.${scheduleFailureSummary} Results will be delivered when complete.`,
				},
			],
			details: withImplicitBlockers(
				{
					projectAgentsDir: null,
					results: [],
					totalDurationMs: 0,
					progress: getProgressSnapshot(),
					async: { state: "running", jobId: startedJobs[0].jobId, type: "task" },
				},
				batchGraph.implicitBlockers,
			),
		};
	}

	async #executeSync(
		_toolCallId: string,
		params: TaskParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
		preAllocatedIds?: string[],
	): Promise<AgentToolResult<TaskToolDetails>> {
		const startTime = Date.now();
		const { agents, projectAgentsDir } = await discoverAgents(this.session.cwd);
		const { agent: agentName, context, schema: outputSchema } = params;
		const isolationMode = this.session.settings.get("task.isolation.mode");
		const explicitIsolation = "isolated" in params ? params.isolated : undefined;
		const isolationRequested = explicitIsolation === true;
		const taskDepth = this.session.taskDepth ?? 0;
		const resolvedTaskFilesDeps = params.tasks?.map(task => ({
			...task,
			filesDeps: task.filesDeps?.map(file => {
				const resolved = path.resolve(this.session.cwd, file);
				return file.endsWith("/") || file.endsWith(path.sep) ? `${resolved}${path.sep}` : resolved;
			}),
		}));
		const autoIsolationReason = (() => {
			if (taskDepth < 1 || isolationMode === "none" || explicitIsolation !== undefined) return undefined;
			if ((params.tasks?.length ?? 0) > 1) return "batch size";
			if (resolvedTaskFilesDeps?.some(task => task.filesDeps?.some(file => isCodeToolSupportedPath(file)))) {
				return "code-supported file scope";
			}
			return undefined;
		})();
		const isAutoIsolated = autoIsolationReason !== undefined;
		const isIsolated = isolationMode !== "none" && (isolationRequested || isAutoIsolated);
		const isolationDowngraded = isolationMode === "none" && isolationRequested;
		const isolationDowngradeNotice = isolationDowngraded
			? 'Task isolation was requested but task.isolation.mode="none"; running non-isolated. Set task.isolation.mode to worktree, fuse-overlay, or fuse-projfs to enable.'
			: "";
		const mergeMode = this.session.settings.get("task.isolation.merge");
		const commitStyle = this.session.settings.get("task.isolation.commits");
		const maxConcurrency = this.session.settings.get("task.maxConcurrency");
		const cacheStaggerMs = this.session.settings.get("task.cacheStaggerMs") ?? 800;
		const _batchModel = params.model?.trim() || undefined;

		// Validate agent exists
		const agent = getAgent(agents, agentName);
		if (!agent) {
			const available = agents.map(a => a.name).join(", ") || "none";
			return {
				content: [
					{
						type: "text",
						text: `Unknown agent "${agentName}". Available: ${available}`,
					},
				],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: 0,
				},
			};
		}

		// Load spell.kdl agent rules
		const projectConfig = await loadSpellKdl(this.session.cwd);
		const userConfig = await loadUserSpellKdl();
		const kdlRules = {
			projectRules: projectConfig?.agents?.rules ?? [],
			userRules: userConfig?.agents?.rules ?? [],
		};

		const planModeState = this.session.getPlanModeState?.();
		const planModeAllowedFolders = listPlanModeAllowedFolders(this.session.settings.get("planMode.allowedFolders"));
		const renderedPlanModeSubagentPrompt = renderPromptTemplate(planModeSubagentPrompt, {
			allowedFolders: planModeAllowedFolders.length > 0 ? planModeAllowedFolders : undefined,
		});
		const planModeTools = ["read", "grep", "find", "ls", "fetch", "web_search", "org"];
		if (planModeAllowedFolders.length > 0) {
			planModeTools.push("write", "edit");
		}
		const effectiveAgent: typeof agent = planModeState?.enabled
			? {
					...agent,
					systemPrompt: `${renderedPlanModeSubagentPrompt}\n\n${agent.systemPrompt}`,
					tools: planModeTools,
					spawns: undefined,
				}
			: agent;

		// Resolve effective agent config (unified precedence: per-call > kdl rules > settings > frontmatter)
		const effectiveConfig = resolveAgentEffectiveConfig({
			agent: effectiveAgent,
			agentName,
			perCallTaskModel: undefined, // populated per-task below
			perCallBatchModel: _batchModel,
			projectRules: kdlRules.projectRules,
			userRules: kdlRules.userRules,
			settings: this.session.settings,
			activeModelPattern: this.session.getActiveModelString?.(),
			fallbackModelPattern: this.session.getModelString?.(),
		});

		// Check if agent is disabled (by rule or settings)
		if (effectiveConfig.disabled) {
			return {
				content: [
					{
						type: "text",
						text: `Agent "${agentName}" is disabled. Enable it via /agents or remove the rule in spell.kdl.`,
					},
				],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: 0,
				},
			};
		}

		const modelOverride = effectiveConfig.model;
		const thinkingLevelOverride = effectiveConfig.thinkingLevel;

		// Output schema priority: agent frontmatter > params > inherited from parent session
		const effectiveOutputSchema = effectiveAgent.output ?? outputSchema ?? this.session.outputSchema;

		// Handle empty or missing tasks
		if (!params.tasks || params.tasks.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `No tasks provided. Use: { agent, context, tasks: [{id, description, args}, ...] }`,
					},
				],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: 0,
				},
			};
		}

		const tasks = await this.#injectVerificationContext(params.tasks);
		const taskValidationError = this.#validateTaskBatch(tasks);
		if (taskValidationError) {
			return {
				content: [{ type: "text", text: `Invalid tasks: ${taskValidationError}` }],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: 0,
				},
			};
		}

		let repoRoot: string | null = null;
		let baseline: WorktreeBaseline | null = null;
		if (isIsolated) {
			try {
				repoRoot = await getRepoRoot(this.session.cwd);
				baseline = await captureBaseline(repoRoot);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text",
							text: `Isolated task execution requires a git repository. ${message}`,
						},
					],
					details: {
						projectAgentsDir,
						results: [],
						totalDurationMs: Date.now() - startTime,
					},
				};
			}
		}

		let effectiveIsolationMode = isolationMode;
		let isolationBackendWarning = "";
		try {
			const resolvedIsolation = await resolveIsolationBackendForTaskExecution(isolationMode, isIsolated, repoRoot);
			effectiveIsolationMode = resolvedIsolation.effectiveIsolationMode;
			isolationBackendWarning = resolvedIsolation.warning;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [
					{
						type: "text",
						text: message,
					},
				],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: Date.now() - startTime,
				},
			};
		}

		// Derive artifacts directory
		const sessionFile = this.session.getSessionFile();
		const artifactsDir = sessionFile ? sessionFile.slice(0, -6) : null;
		const tempArtifactsDir = artifactsDir ? null : path.join(os.tmpdir(), `spell-task-${Snowflake.next()}`);
		const effectiveArtifactsDir = artifactsDir || tempArtifactsDir!;

		// Initialize progress tracking
		const progressMap = new Map<number, AgentProgress>();
		const startedTodoRefs = new Set<string>();

		// Update callback
		const emitProgress = () => {
			const progress = Array.from(progressMap.values()).sort((a, b) => a.index - b.index);
			onUpdate?.({
				content: [{ type: "text", text: `Running ${params.tasks.length} agents...` }],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: Date.now() - startTime,
					progress,
				},
			});
		};

		try {
			// Check self-recursion prevention
			if (this.#blockedAgent && agentName === this.#blockedAgent) {
				return {
					content: [
						{
							type: "text",
							text: `Cannot spawn ${this.#blockedAgent} agent from within itself (recursion prevention). Use a different agent type.`,
						},
					],
					details: {
						projectAgentsDir,
						results: [],
						totalDurationMs: Date.now() - startTime,
					},
				};
			}

			// Check spawn restrictions from parent
			const parentSpawns = this.session.getSessionSpawns() ?? "*";
			const allowedSpawns = parentSpawns.split(",").map(s => s.trim());
			const isSpawnAllowed = (): boolean => {
				if (parentSpawns === "") return false; // Empty = deny all
				if (parentSpawns === "*") return true; // Wildcard = allow all
				return allowedSpawns.includes(agentName);
			};

			if (!isSpawnAllowed()) {
				const allowed = parentSpawns === "" ? "none (spawns disabled for this agent)" : parentSpawns;
				return {
					content: [{ type: "text", text: `Cannot spawn '${agentName}'. Allowed: ${allowed}` }],
					details: {
						projectAgentsDir,
						results: [],
						totalDurationMs: Date.now() - startTime,
					},
				};
			}

			// Write parent conversation context for subagents
			await fs.mkdir(effectiveArtifactsDir, { recursive: true });
			const compactContext = this.session.getCompactContext?.();
			let contextFilePath: string | undefined;
			if (compactContext) {
				contextFilePath = path.join(effectiveArtifactsDir, "context.md");
				await Bun.write(contextFilePath, compactContext);
			}

			// Allocate unique IDs across the session to prevent artifact collisions
			let uniqueIds: string[];
			if (preAllocatedIds && preAllocatedIds.length === tasks.length) {
				uniqueIds = preAllocatedIds;
			} else {
				const outputManager =
					this.session.agentOutputManager ?? new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
				uniqueIds = await outputManager.allocateBatch(tasks.map(t => t.id));
			}
			const taskExecutions = tasks.map((task, index) => ({
				logicalId: task.id,
				executionId: uniqueIds[index] ?? task.id,
				blockers: task.blockers,
				todoRef: task.todoRef,
				filesDeps: task.filesDeps,
				taskCallModel: task.model?.trim() || undefined,
				...renderTemplate(context, task),
			}));
			const syncBatchGraph = buildBatchGraph(
				taskExecutions.map(taskExecution => ({
					id: taskExecution.logicalId,
					blockers: taskExecution.blockers,
					filesDeps: taskExecution.filesDeps,
				})),
			);
			const implicitBlockerNote = buildImplicitBlockerNote(syncBatchGraph.implicitBlockers, this.session.cwd);
			const availableSkills = [...(this.session.skills ?? [])];
			const contextFiles = this.session.contextFiles?.filter(
				file => path.basename(file.path).toLowerCase() !== "agents.md",
			);
			const promptTemplates = this.session.promptTemplates;

			// Initialize progress for all tasks
			for (let i = 0; i < taskExecutions.length; i++) {
				const taskExecution = taskExecutions[i];
				progressMap.set(i, {
					index: i,
					id: taskExecution.logicalId,
					agent: agentName,
					agentSource: agent.source,
					status: "pending",
					task: taskExecution.task,
					assignment: taskExecution.assignment,
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					tokens: 0,
					durationMs: 0,
					modelOverride,
					description: taskExecution.description,
				});
			}
			emitProgress();

			const runTask = async (
				taskExecution: (typeof taskExecutions)[number],
				index: number,
				runSignal: AbortSignal,
			) => {
				const originalTask = tasks[index]!;
				const returnWithTodoRef = async (
					result: SingleResult,
					isolationContext?: { isolationDir: string; baselineHeadCommit: string },
				): Promise<SingleResult> => {
					await this.#finalizeTodoRef(originalTask, result, isolationContext);
					return result;
				};
				const updateProgress = (progress: AgentProgress): void => {
					progressMap.set(index, {
						...structuredClone(progress),
						index,
						id: taskExecution.logicalId,
					});
					this.#markTodoRefStarted(originalTask, progress, startedTodoRefs);
					this.#syncTodoRefChildPhases(originalTask, progress.todoGroups);
					emitProgress();
				};
				if (!isIsolated) {
					const result = await runSubprocess({
						cwd: this.session.cwd,
						agent: effectiveAgent,
						task: taskExecution.task,
						assignment: taskExecution.assignment,
						description: taskExecution.description,
						index,
						id: taskExecution.executionId,
						taskDepth,
						modelOverride,
						thinkingLevel: thinkingLevelOverride,
						outputSchema: effectiveOutputSchema,
						runtimeVerification: this.#buildRuntimeVerificationOptions(originalTask.todoRef),
						sessionFile,
						persistArtifacts: !!artifactsDir,
						artifactsDir: effectiveArtifactsDir,
						contextFile: contextFilePath,
						signal: runSignal,
						eventBus: this.session.eventBus,
						onProgress: updateProgress,
						authStorage: this.session.authStorage,
						modelRegistry: this.session.modelRegistry,
						settings: this.session.settings,
						sandboxPolicy: this.session.sandboxPolicy,
						filesDeps: taskExecution.filesDeps,
						mcpManager: this.session.mcpManager,
						contextFiles,
						skills: availableSkills,
						promptTemplates,
					});
					return returnWithTodoRef(result);
				}

				const taskStart = Date.now();
				let isolationDir: string | undefined;
				try {
					if (!repoRoot || !baseline) {
						throw new Error("Isolated task execution not initialized.");
					}
					const taskBaseline = structuredClone(baseline);

					if (effectiveIsolationMode === "fuse-overlay") {
						isolationDir = await ensureFuseOverlay(repoRoot, taskExecution.executionId);
					} else if (effectiveIsolationMode === "fuse-projfs") {
						isolationDir = await ensureProjfsOverlay(repoRoot, taskExecution.executionId);
					} else {
						isolationDir = await ensureWorktree(repoRoot, taskExecution.executionId);
						await applyBaseline(isolationDir, taskBaseline);
					}
					// Build context for gate verification against this worktree, not the parent cwd.
					const isolationContext = { isolationDir, baselineHeadCommit: taskBaseline.root.headCommit };

					const result = await runSubprocess({
						cwd: this.session.cwd,
						worktree: isolationDir,
						agent: effectiveAgent,
						task: taskExecution.task,
						assignment: taskExecution.assignment,
						description: taskExecution.description,
						index,
						id: taskExecution.executionId,
						taskDepth,
						modelOverride,
						thinkingLevel: thinkingLevelOverride,
						outputSchema: effectiveOutputSchema,
						runtimeVerification: this.#buildRuntimeVerificationOptions(originalTask.todoRef, isolationContext),
						sessionFile,
						persistArtifacts: !!artifactsDir,
						artifactsDir: effectiveArtifactsDir,
						contextFile: contextFilePath,
						signal: runSignal,
						eventBus: this.session.eventBus,
						onProgress: updateProgress,
						authStorage: this.session.authStorage,
						modelRegistry: this.session.modelRegistry,
						settings: this.session.settings,
						sandboxPolicy: this.session.sandboxPolicy,
						filesDeps: taskExecution.filesDeps,
						mcpManager: this.session.mcpManager,
						contextFiles,
						skills: availableSkills,
						promptTemplates,
					});
					if (mergeMode === "branch" && result.exitCode === 0) {
						try {
							const commitMsg =
								commitStyle === "ai" && this.session.modelRegistry
									? async (diff: string) => {
											return generateCommitMessage(
												diff,
												this.session.modelRegistry!,
												this.session.settings,
												this.session.getSessionId?.() ?? undefined,
											);
										}
									: undefined;
							const commitResult = await commitToBranch(
								isolationDir,
								taskBaseline,
								taskExecution.executionId,
								taskExecution.description,
								commitMsg,
							);
							return returnWithTodoRef(
								{
									...result,
									branchName: commitResult?.branchName,
									nestedPatches: commitResult?.nestedPatches,
								},
								isolationContext,
							);
						} catch (mergeErr) {
							// Agent succeeded but branch commit failed — clean up stale branch
							const branchName = `spell/task/${taskExecution.executionId}`;
							await $`git branch -D ${branchName}`.cwd(repoRoot).quiet().nothrow();
							const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
							return returnWithTodoRef({ ...result, error: `Merge failed: ${msg}` }, isolationContext);
						}
					}
					if (result.exitCode === 0) {
						try {
							const delta = await captureDeltaPatch(isolationDir, taskBaseline);
							const patchPath = path.join(effectiveArtifactsDir, `${taskExecution.executionId}.patch`);
							await Bun.write(patchPath, delta.rootPatch);
							return returnWithTodoRef(
								{
									...result,
									patchPath,
									nestedPatches: delta.nestedPatches,
								},
								isolationContext,
							);
						} catch (patchErr) {
							const msg = patchErr instanceof Error ? patchErr.message : String(patchErr);
							return returnWithTodoRef({ ...result, error: `Patch capture failed: ${msg}` }, isolationContext);
						}
					}
					return returnWithTodoRef(result, isolationContext);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return returnWithTodoRef({
						index,
						id: taskExecution.executionId,
						agent: agent.name,
						agentSource: agent.source,
						task: taskExecution.task,
						assignment: taskExecution.assignment,
						description: taskExecution.description,
						exitCode: 1,
						outcome: "failed",
						stderr: message,
						resultUri: `agent://${taskExecution.executionId}`,
						textPreview: message,
						durationMs: Date.now() - taskStart,
						tokens: 0,
						modelOverride,
						error: message,
					});
				} finally {
					if (isolationDir) {
						if (effectiveIsolationMode === "fuse-overlay") {
							await cleanupFuseOverlay(isolationDir);
						} else if (effectiveIsolationMode === "fuse-projfs") {
							await cleanupProjfsOverlay(isolationDir);
						} else {
							await cleanupWorktree(isolationDir);
						}
					}
				}
			};

			const batchResults = await scheduleBatch(
				taskExecutions.map((taskExecution, index) => ({
					id: taskExecution.logicalId,
					blockers: taskExecution.blockers,
					filesDeps: taskExecution.filesDeps,
					run: runSignal => runTask(taskExecution, index, runSignal),
				})),
				{ maxConcurrency, signal, staggerMs: cacheStaggerMs },
			);
			const results: SingleResult[] = batchResults.map((batchResult, index) => {
				if (batchResult.status === "completed" && batchResult.result) {
					return batchResult.result;
				}
				const taskExecution = taskExecutions[index]!;
				const errorMessage = batchResult.error ?? "Task execution failed";
				const aborted = batchResult.status === "aborted";
				return {
					index,
					id: taskExecution.executionId,
					agent: agentName,
					agentSource: agent.source,
					task: taskExecution.task,
					assignment: taskExecution.assignment,
					description: taskExecution.description,
					exitCode: 1,
					outcome: aborted ? "aborted" : "failed",
					stderr: errorMessage,
					resultUri: `agent://${taskExecution.executionId}`,
					textPreview: errorMessage,
					durationMs: 0,
					tokens: 0,
					modelOverride,
					error: errorMessage,
					aborted: aborted || undefined,
					abortReason: aborted ? errorMessage : undefined,
				};
			});

			for (let index = 0; index < batchResults.length; index++) {
				const batchResult = batchResults[index]!;
				if (batchResult.status === "completed") continue;
				await this.#finalizeSkippedTodoRef(
					tasks[index]!,
					agentName,
					agent.source,
					batchResult.error ?? "Task execution failed",
					batchResult.status === "aborted",
				);
			}

			// Aggregate usage from executor results (already accumulated incrementally)
			const aggregatedUsage = createUsageTotals();
			let hasAggregatedUsage = false;
			for (const result of results) {
				if (result.usage) {
					addUsageTotals(aggregatedUsage, result.usage);
					hasAggregatedUsage = true;
				}
			}

			// Collect patch paths (artifacts already written by executor in real-time)
			const patchPaths: string[] = [];
			for (const result of results) {
				if (result.patchPath) {
					patchPaths.push(result.patchPath);
				}
			}

			let mergeSummary = "";
			let changesApplied: boolean | null = null;
			let mergedBranchesForNestedPatches: Set<string> | null = null;
			if (isIsolated && repoRoot) {
				if (mergeMode === "branch") {
					// Branch mode: merge task branches sequentially
					const branchEntries = results
						.filter(r => r.branchName && r.exitCode === 0 && !r.aborted)
						.map(r => ({ branchName: r.branchName!, taskId: r.id, description: r.description }));

					if (branchEntries.length === 0) {
						changesApplied = true;
					} else {
						const mergeResult = await mergeTaskBranches(repoRoot, branchEntries);
						mergedBranchesForNestedPatches = new Set(mergeResult.merged);
						changesApplied = mergeResult.failed.length === 0;

						if (changesApplied) {
							mergeSummary = `\n\nMerged ${mergeResult.merged.length} branch${mergeResult.merged.length === 1 ? "" : "es"}: ${mergeResult.merged.join(", ")}`;
						} else {
							const mergedPart =
								mergeResult.merged.length > 0 ? `Merged: ${mergeResult.merged.join(", ")}.\n` : "";
							const failedPart = `Failed: ${mergeResult.failed.join(", ")}.`;
							const conflictPart = mergeResult.conflict ? `\nConflict: ${mergeResult.conflict}` : "";
							mergeSummary = `\n\n<system-notification>Branch merge failed. ${mergedPart}${failedPart}${conflictPart}\nUnmerged branches remain for manual resolution.</system-notification>`;
						}
					}

					// Clean up merged branches (keep failed ones for manual resolution)
					const allBranches = branchEntries.map(b => b.branchName);
					if (changesApplied) {
						await cleanupTaskBranches(repoRoot, allBranches);
					}
				} else {
					// Patch mode: combine and apply patches
					const patchesInOrder = results.map(result => result.patchPath).filter(Boolean) as string[];
					const missingPatch = results.some(result => !result.patchPath);
					if (missingPatch) {
						changesApplied = false;
					} else {
						const patchStats = await Promise.all(
							patchesInOrder.map(async patchPath => ({
								patchPath,
								size: (await fs.stat(patchPath)).size,
							})),
						);
						const nonEmptyPatches = patchStats.filter(patch => patch.size > 0).map(patch => patch.patchPath);
						if (nonEmptyPatches.length === 0) {
							changesApplied = true;
						} else {
							const patchTexts = await Promise.all(
								nonEmptyPatches.map(async patchPath => Bun.file(patchPath).text()),
							);
							const combinedPatch = patchTexts.map(text => (text.endsWith("\n") ? text : `${text}\n`)).join("");
							if (!combinedPatch.trim()) {
								changesApplied = true;
							} else {
								const combinedPatchPath = path.join(
									os.tmpdir(),
									`spell-task-combined-${Snowflake.next()}.patch`,
								);
								try {
									await Bun.write(combinedPatchPath, combinedPatch);
									const checkResult = await $`git apply --check --binary ${combinedPatchPath}`
										.cwd(repoRoot)
										.quiet()
										.nothrow();
									if (checkResult.exitCode !== 0) {
										changesApplied = false;
									} else {
										const applyResult = await $`git apply --binary ${combinedPatchPath}`
											.cwd(repoRoot)
											.quiet()
											.nothrow();
										changesApplied = applyResult.exitCode === 0;
									}
								} finally {
									await fs.rm(combinedPatchPath, { force: true });
								}
							}
						}
					}

					if (changesApplied) {
						mergeSummary = "\n\nApplied patches: yes";
					} else {
						const notification =
							"<system-notification>Patches were not applied and must be handled manually.</system-notification>";
						const patchList =
							patchPaths.length > 0
								? `\n\nPatch artifacts:\n${patchPaths.map(patch => `- ${patch}`).join("\n")}`
								: "";
						mergeSummary = `\n\n${notification}${patchList}`;
					}
				}
			}

			// Apply nested repo patches (separate from parent git)
			if (isIsolated && repoRoot && (mergeMode === "branch" || changesApplied !== false)) {
				const allNestedPatches = results
					.filter(r => {
						if (!r.nestedPatches || r.nestedPatches.length === 0 || r.exitCode !== 0 || r.aborted) {
							return false;
						}
						if (mergeMode !== "branch") {
							return true;
						}
						if (!r.branchName || !mergedBranchesForNestedPatches) {
							return false;
						}
						return mergedBranchesForNestedPatches.has(r.branchName);
					})
					.flatMap(r => r.nestedPatches!);
				if (allNestedPatches.length > 0) {
					try {
						const commitMsg =
							commitStyle === "ai" && this.session.modelRegistry
								? async (diff: string) => {
										return generateCommitMessage(
											diff,
											this.session.modelRegistry!,
											this.session.settings,
											this.session.getSessionId?.() ?? undefined,
										);
									}
								: undefined;
						await applyNestedPatches(repoRoot, allNestedPatches, commitMsg);
					} catch {
						// Nested patch failures are non-fatal to the parent merge
						mergeSummary +=
							"\n\n<system-notification>Some nested repository patches failed to apply.</system-notification>";
					}
				}
			}

			// Build final output - match plugin format
			const successCount = results.filter(r => isSuccessfulOutcome(r.outcome)).length;
			const outcomeCounts = new Map<SubagentOutcome, number>();
			for (const result of results) {
				outcomeCounts.set(result.outcome, (outcomeCounts.get(result.outcome) ?? 0) + 1);
			}
			const outcomeBreakdown = Array.from(outcomeCounts.entries())
				.sort((left, right) => left[0].localeCompare(right[0]))
				.map(([outcome, count]) => `${outcome}:${count}`)
				.join(", ");
			const totalDuration = Date.now() - startTime;

			const summaries = results.map(r => {
				const structuredInline = getResultInlineStructured(r);
				const preview = r.textPreview?.trim() || (!structuredInline ? getResultPreviewText(r) : undefined);
				const children = (r.children ?? []).map(child => ({
					id: child.id,
					outcome: child.outcome,
					resultUri: child.resultUri,
				}));
				return {
					agent: r.agent,
					outcome: r.outcome,
					status: formatOutcomeLabel(r),
					id: r.id,
					preview,
					structuredInline,
					resultUri: r.resultUri,
					children,
					hasChildren: children.length > 0,
					spawnAudit:
						r.spawnAudit && (!r.spawnAudit.granted || r.spawnAudit.reason === "depth-capped")
							? r.spawnAudit
							: undefined,
					meta: r.outputMeta
						? {
								lineCount: r.outputMeta.lineCount,
								charSize: formatBytes(r.outputMeta.charCount),
							}
						: undefined,
				};
			});

			const backendSummaryPrefix = isolationBackendWarning ? `\n\n${isolationBackendWarning}` : "";
			const downgradeSummaryPrefix = isolationDowngradeNotice ? `\n\n${isolationDowngradeNotice}` : "";
			const autoIsolationSummaryPrefix = isAutoIsolated
				? `\n\nTask isolation auto-coerced (${autoIsolationReason}); running isolated.`
				: "";
			const summary = `${implicitBlockerNote}${renderPromptTemplate(taskSummaryTemplate, {
				successCount,
				totalCount: results.length,
				outcomeBreakdown: outcomeBreakdown ? `(${outcomeBreakdown})` : undefined,
				duration: formatDuration(totalDuration),
				summaries,
				agentName,
				mergeSummary: `${backendSummaryPrefix}${downgradeSummaryPrefix}${autoIsolationSummaryPrefix}${mergeSummary}`,
			})}`;

			// Cleanup temp directory if used
			const shouldCleanupTempArtifacts =
				tempArtifactsDir && (!isIsolated || changesApplied === true || changesApplied === null);
			if (shouldCleanupTempArtifacts) {
				await fs.rm(tempArtifactsDir, { recursive: true, force: true });
			}

			return {
				content: [{ type: "text", text: summary }],
				details: withImplicitBlockers(
					{
						projectAgentsDir,
						results: results,
						totalDurationMs: totalDuration,
						usage: hasAggregatedUsage ? aggregatedUsage : undefined,
						isolationDowngraded: isolationDowngraded || undefined,
						isolationAutoCoerced: isAutoIsolated || undefined,
					},
					syncBatchGraph.implicitBlockers,
				),
			};
		} catch (err) {
			return {
				content: [{ type: "text", text: `Task execution failed: ${err}` }],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: Date.now() - startTime,
				},
			};
		}
	}
}

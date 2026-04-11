import * as async_hooks from "node:async_hooks";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { StringEnum } from "@oh-my-pi/pi-ai";
import {
	DEFAULT_ORG_CONFIG,
	findItemById,
	resolveCategories,
	updateItemStateInFile,
	writeJournal,
} from "@oh-my-pi/pi-org";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { getProjectDir, logger } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import chalk from "chalk";
import { renderPromptTemplate } from "../config/prompt-templates";
import { applyPolicyGates, type TaskPolicy, type TaskPolicyGates } from "../config/task-policies";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { buildOrgConfig } from "../plan-mode/org-plan";
import todoWriteDescription from "../prompts/tools/todo-write.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { resolveArtifactScopeFromArtifactsDir, resolveArtifactScopeFromSessionFile } from "../session/artifacts";
import type { GitBaseline } from "../session/git-baseline";
import type { SessionEntry } from "../session/session-manager";
import { buildTaskUri, resolveTaskUri, type TaskUriContext } from "../swarm/uri";
import { type GateFailure, verifyGates } from "../task/gate-verification";
import { MutableDag } from "../task/mutable-dag";
import { renderStatusLine, renderTreeList } from "../tui";
import { PREVIEW_LIMITS } from "./render-utils";

// =============================================================================
// Types
// =============================================================================

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "failed" | "gate_failed";
export type TodoKind = "work" | "data";

export interface TodoDelegationResult {
	output?: string;
	error?: string;
	outputPath?: string;
	gateFailures?: Array<{ taskId?: string; gate: string; expected: string; detail: string }>;
}

export interface TodoDelegation {
	sessionId: string;
	transcriptPath?: string;
	agent?: string;
	childPhases?: TodoPhase[];
	result?: TodoDelegationResult;
}

export interface TodoItem {
	id: string;
	uri?: string;
	kind?: TodoKind;
	content: string;
	status: TodoStatus;
	notes?: string;
	details?: string;
	filesDeps?: string[];
	dataContent?: string;
	artifactPath?: string;
	children?: TodoItem[];
	gateCommit?: boolean;
	gateArtifact?: string;
	gateCmd?: string;
	gateLlm?: string;
	verifyCmd?: string;
	blockers?: string[];
	/** Non-gating reference to org item. Tracks lineage without triggering verification. */
	orgItemId?: string;
	/** Gating reference. Triggers two-phase verification protocol on completion. */
	orgItemClosingId?: string;
	/** FUP org item ID. Required when status=abandoned (deferral tracking). */
	deferralFupId?: string;
	/** Baseline captured when a direct gated task enters in_progress; used for later gateCommit verification. */
	gitBaseline?: GitBaseline | null;
	/** Delegated subagent metadata. Delegated tasks may remain in_progress alongside one direct task. */
	delegation?: TodoDelegation;
	/** Layer for policy-based gate injection. When set, matching policy gates are auto-injected. */
	layer?: string;
}

/**
 * Cosmetic grouping only. Ordering comes from blockers/DAG edges, not group position.
 * The legacy name is retained temporarily because session/UI plumbing still references `phases`.
 */
export interface TodoPhase {
	id: string;
	name: string;
	tasks: TodoItem[];
}

export interface TodoWriteToolDetails {
	phases: TodoPhase[];
	groups?: TodoPhase[];
	storage: "session" | "memory";
}

// =============================================================================
// Schema
// =============================================================================

const StatusEnum = StringEnum(["pending", "in_progress", "completed", "abandoned", "failed", "gate_failed"] as const, {
	description: "Task status",
});

const KindEnum = StringEnum(["work", "data"] as const, {
	description: "Todo node kind",
});

const DelegationSchema = Type.Object({
	sessionId: Type.String({ description: "Delegated subagent session ID" }),
	transcriptPath: Type.Optional(Type.String({ description: "Transcript path for the delegated subagent session" })),
	agent: Type.Optional(Type.String({ description: "Agent type handling the delegated work" })),
});

const InputTask = Type.Object({
	slug: Type.Optional(Type.String({ description: "Stable slug/ID for the task. Defaults to task-N." })),
	uri: Type.Optional(
		Type.String({
			description:
				"Canonical task:// or data:// URI. When omitted, todo_write builds one from the current session context.",
		}),
	),
	kind: Type.Optional(KindEnum),
	content: Type.String({ description: "Task description" }),
	notes: Type.Optional(Type.String({ description: "Additional context or notes" })),
	details: Type.Optional(
		Type.String({ description: "Implementation details, file paths, and specifics (shown only when active)" }),
	),
	filesDeps: Type.Optional(
		Type.Array(Type.String({ description: "Files this task mutates; used for isolation overlap checks" })),
	),
	dataContent: Type.Optional(Type.String({ description: "Inline content that satisfies a data node" })),
	artifactPath: Type.Optional(Type.String({ description: "Artifact path that satisfies a data node" })),
	gateCommit: Type.Optional(Type.Boolean({ description: "Require commit after completing this task" })),
	gateArtifact: Type.Optional(Type.String({ description: "Path to artifact that must exist after completion" })),
	gateCmd: Type.Optional(Type.String({ description: "Command to run for verification" })),
	gateLlm: Type.Optional(Type.String({ description: "LLM review criteria" })),
	verifyCmd: Type.Optional(Type.String({ description: "Recommended verification command" })),
	blockers: Type.Optional(Type.Array(Type.String({ description: "Task ID, slug, or URI that blocks this task" }))),
	orgItemId: Type.Optional(Type.String({ description: "Org item ID for lineage tracking (non-gating)" })),
	orgItemClosingId: Type.Optional(
		Type.String({ description: "Org item ID that triggers two-phase verified completion" }),
	),
	delegation: Type.Optional(DelegationSchema),
	layer: Type.Optional(Type.String({ description: "Layer for policy-based gate injection" })),
});

const InputPhase = Type.Object({
	name: Type.String({ description: "Group name" }),
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
				name: Type.String({ description: "Group name" }),
				tasks: Type.Optional(Type.Array(InputTask)),
			}),
			Type.Object({
				op: Type.Literal("add_group"),
				name: Type.String({ description: "Group name" }),
				tasks: Type.Optional(Type.Array(InputTask)),
			}),
			Type.Object({
				op: Type.Literal("add_task"),
				phase: Type.String({ description: "Group ID, e.g. phase-1" }),
				slug: Type.Optional(Type.String({ description: "Stable slug/ID for the task. Defaults to task-N." })),
				uri: Type.Optional(Type.String({ description: "Canonical task:// or data:// URI for the task" })),
				kind: Type.Optional(KindEnum),
				content: Type.String({ description: "Task description" }),
				notes: Type.Optional(Type.String({ description: "Additional context or notes" })),
				details: Type.Optional(Type.String({ description: "Implementation details, file paths, and specifics" })),
				filesDeps: Type.Optional(Type.Array(Type.String())),
				dataContent: Type.Optional(Type.String()),
				artifactPath: Type.Optional(Type.String()),
				gateCommit: Type.Optional(Type.Boolean()),
				gateArtifact: Type.Optional(Type.String()),
				gateCmd: Type.Optional(Type.String()),
				gateLlm: Type.Optional(Type.String()),
				verifyCmd: Type.Optional(Type.String()),
				blockers: Type.Optional(Type.Array(Type.String())),
				orgItemId: Type.Optional(Type.String()),
				orgItemClosingId: Type.Optional(Type.String()),
				delegation: Type.Optional(DelegationSchema),
				layer: Type.Optional(Type.String({ description: "Layer for policy-based gate injection" })),
			}),
			Type.Object({
				op: Type.Literal("update"),
				id: Type.String({ description: "Task ID, slug, or URI" }),
				status: Type.Optional(StatusEnum),
				content: Type.Optional(Type.String({ description: "Updated task description" })),
				notes: Type.Optional(Type.String({ description: "Additional context or notes" })),
				details: Type.Optional(Type.String({ description: "Updated details" })),
				filesDeps: Type.Optional(Type.Array(Type.String())),
				dataContent: Type.Optional(Type.String()),
				artifactPath: Type.Optional(Type.String()),
				gateCommit: Type.Optional(Type.Boolean()),
				gateArtifact: Type.Optional(Type.String()),
				gateCmd: Type.Optional(Type.String()),
				gateLlm: Type.Optional(Type.String()),
				verifyCmd: Type.Optional(Type.String()),
				blockers: Type.Optional(Type.Array(Type.String())),
				orgItemId: Type.Optional(Type.String()),
				orgItemClosingId: Type.Optional(Type.String()),
				delegation: Type.Optional(DelegationSchema),
				layer: Type.Optional(Type.String({ description: "Layer for policy-based gate injection" })),
				verified: Type.Optional(
					Type.Boolean({
						description: "Set true after verifying all gate requirements. Required to complete a gated task.",
					}),
				),
				deferralFupId: Type.Optional(
					Type.String({
						description: "FUP org item ID for deferral tracking. Required when status=abandoned.",
					}),
				),
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

export function findTask(phases: TodoPhase[], id: string): TodoItem | undefined {
	for (const phase of phases) {
		const task = phase.tasks.find(t => t.id === id || t.uri === id);
		if (task) return task;
	}
	return undefined;
}

interface ResolvedTodoContext extends TaskUriContext {
	currentSessionId: string;
	currentAgentName: string;
}

function resolveTodoContext(
	session: Pick<ToolSession, "getSessionFile" | "getSessionId" | "getArtifactsDir">,
): ResolvedTodoContext {
	const artifactsDir = session.getArtifactsDir?.() ?? undefined;
	if (artifactsDir) {
		const scope = resolveArtifactScopeFromArtifactsDir(artifactsDir);
		return {
			currentSessionId: scope.sessionId ?? session.getSessionId?.() ?? "current",
			currentAgentName: scope.agentName,
		};
	}
	const sessionFile = session.getSessionFile();
	if (sessionFile) {
		const scope = resolveArtifactScopeFromSessionFile(sessionFile, session.getSessionId?.() ?? undefined);
		return { currentSessionId: scope.sessionId, currentAgentName: scope.agentName };
	}
	return { currentSessionId: session.getSessionId?.() ?? "current", currentAgentName: "main" };
}

function buildTodoUri(task: Pick<TodoItem, "id" | "kind" | "uri">, context: ResolvedTodoContext): string {
	if (task.uri) return task.uri;
	return buildTaskUri({
		scheme: task.kind === "data" ? "data" : "task",
		sessionId: context.currentSessionId,
		agentName: context.currentAgentName,
		slug: task.id,
	});
}

function hydrateTodoItem(task: TodoItem, context: ResolvedTodoContext): TodoItem {
	const hydrated: TodoItem = {
		...task,
		kind: task.kind ?? "work",
		uri: buildTodoUri(task, context),
		filesDeps: task.filesDeps ? [...task.filesDeps] : undefined,
		blockers: task.blockers ? [...task.blockers] : undefined,
		children: task.children ? task.children.map(child => hydrateTodoItem(child, context)) : undefined,
		delegation: cloneTodoDelegation(task.delegation),
	};
	return hydrated;
}

function isSatisfiedDataNode(task: TodoItem): boolean {
	if ((task.kind ?? "work") !== "data") return false;
	if (task.status === "completed") return true;
	return Boolean(task.dataContent || task.artifactPath || task.delegation?.result?.outputPath);
}

function buildPhaseFromInput(
	input: { name: string; tasks?: Array<Static<typeof InputTask>> },
	phaseId: string,
	nextTaskId: number,
	policies: TaskPolicy[],
	context: ResolvedTodoContext,
): { phase: TodoPhase; nextTaskId: number } {
	const tasks: TodoItem[] = [];
	let tid = nextTaskId;
	for (const t of input.tasks ?? []) {
		const id = t.slug ?? `task-${tid++}`;
		const task: TodoItem = hydrateTodoItem(
			{
				id,
				uri: t.uri,
				kind: t.kind,
				content: t.content,
				status: "pending",
				notes: t.notes,
				details: t.details,
				filesDeps: t.filesDeps,
				dataContent: t.dataContent,
				artifactPath: t.artifactPath,
				gateCommit: t.gateCommit,
				gateArtifact: t.gateArtifact,
				gateCmd: t.gateCmd,
				gateLlm: t.gateLlm,
				verifyCmd: t.verifyCmd,
				blockers: t.blockers,
				orgItemId: t.orgItemId,
				orgItemClosingId: t.orgItemClosingId,
				delegation: cloneTodoDelegation(t.delegation),
				layer: t.layer,
			},
			context,
		);
		injectPolicyGates(task, policies);
		tasks.push(task);
	}
	return { phase: { id: phaseId, name: input.name, tasks }, nextTaskId: tid };
}

export function getNextTodoIds(phases: TodoPhase[]): { nextTaskId: number; nextPhaseId: number } {
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
	const { nextTaskId, nextPhaseId } = getNextTodoIds(phases);
	return { phases, nextTaskId, nextPhaseId };
}

function cloneTodoDelegation(delegation: TodoDelegation | undefined): TodoDelegation | undefined {
	if (!delegation) return undefined;
	return {
		...delegation,
		childPhases: delegation.childPhases ? cloneTodoPhases(delegation.childPhases) : undefined,
		result: delegation.result ? { ...delegation.result } : undefined,
	};
}

function cloneTodoTask(task: TodoItem): TodoItem {
	return {
		...task,
		blockers: task.blockers ? [...task.blockers] : undefined,
		filesDeps: task.filesDeps ? [...task.filesDeps] : undefined,
		children: task.children ? task.children.map(child => cloneTodoTask(child)) : undefined,
		delegation: cloneTodoDelegation(task.delegation),
	};
}

export function cloneTodoPhases(phases: TodoPhase[]): TodoPhase[] {
	return phases.map(phase => ({ ...phase, tasks: phase.tasks.map(task => cloneTodoTask(task)) }));
}

export function injectPolicyGates(task: TodoItem, policies: TaskPolicy[]): void {
	if (!task.layer || policies.length === 0) return;
	const resolved = applyPolicyGates(
		{
			gateCommit: task.gateCommit,
			gateArtifact: task.gateArtifact,
			gateCmd: task.gateCmd,
			gateLlm: task.gateLlm,
			verifyCmd: task.verifyCmd,
		} satisfies TaskPolicyGates,
		task.layer,
		policies,
	);
	task.gateCommit = resolved.gateCommit;
	task.gateArtifact = resolved.gateArtifact;
	task.gateCmd = resolved.gateCmd;
	task.gateLlm = resolved.gateLlm;
	task.verifyCmd = resolved.verifyCmd;
}

const todoMutationQueues = new WeakMap<ToolSession, Promise<unknown>>();
const todoMutationContext = new async_hooks.AsyncLocalStorage<true>();

export function queueTodoMutation<T>(session: ToolSession, action: () => Promise<T>): Promise<T> {
	if (todoMutationContext.getStore()) {
		return action();
	}
	const previous = todoMutationQueues.get(session) ?? Promise.resolve();
	const next = previous.catch(() => undefined).then(() => todoMutationContext.run(true, action));
	todoMutationQueues.set(
		session,
		next.then(
			() => undefined,
			() => undefined,
		),
	);
	return next;
}

export function isDelegatedTask(task: TodoItem): boolean {
	return task.delegation !== undefined;
}

const ORG_DOING_OR_LATER_STATES = new Set(["DOING", "REVIEW", "DONE", "BLOCKED"]);
const ORG_DONE_OR_LATER_STATES = new Set(["DONE", "BLOCKED"]);

function flattenTasks(phases: TodoPhase[]): TodoItem[] {
	return phases.flatMap(phase => phase.tasks);
}

type OrgTransitionResult = "transitioned" | "not-found" | "skipped";

async function transitionOrgItemIfNeeded(
	projectRoot: string,
	todoKeywords: string[],
	orgItemId: string,
	targetState: "DOING" | "DONE",
): Promise<OrgTransitionResult> {
	const config = { ...DEFAULT_ORG_CONFIG, todoKeywords };
	const categories = resolveCategories(config, projectRoot);
	const catDirs = categories.map(category => ({
		absPath: category.absPath,
		name: category.name,
		dir: category.dirName,
	}));
	const item = await findItemById(catDirs, orgItemId, todoKeywords);
	if (!item) {
		logger.warn("todo_write: linked org item not found", { orgItemId, targetState });
		return "not-found";
	}
	const skipStates = targetState === "DOING" ? ORG_DOING_OR_LATER_STATES : ORG_DONE_OR_LATER_STATES;
	if (skipStates.has(item.state)) {
		return "skipped";
	}
	const updated = await updateItemStateInFile(item.file, orgItemId, targetState, todoKeywords);
	if (!updated) {
		logger.warn("todo_write: org state transition returned false", { orgItemId, targetState, file: item.file });
		return "skipped";
	}
	return "transitioned";
}

async function applyOrgLifecycleHooks(
	session: ToolSession,
	previousPhases: TodoPhase[],
	nextPhases: TodoPhase[],
): Promise<string[]> {
	if (!session.settings.get("org.enabled")) {
		return [];
	}
	const projectRoot = session.cwd ?? getProjectDir();
	const todoKeywords = [...buildOrgConfig(session.settings).todoKeywords];
	const previousStatus = new Map(flattenTasks(previousPhases).map(task => [task.id, task.status]));
	const notices: string[] = [];
	for (const task of flattenTasks(nextPhases)) {
		const oldStatus = previousStatus.get(task.id);
		if (task.status === "in_progress" && oldStatus !== "in_progress" && task.orgItemId) {
			try {
				const result = await transitionOrgItemIfNeeded(projectRoot, todoKeywords, task.orgItemId, "DOING");
				if (result === "transitioned") {
					notices.push(`INFO: Org item ${task.orgItemId} auto-transitioned to DOING.`);
				} else if (result === "not-found") {
					notices.push(`WARN: Org item ${task.orgItemId} not found for DOING transition.`);
				}
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				logger.error("todo_write: failed to auto-transition org item to DOING", {
					error,
					orgItemId: task.orgItemId,
				});
				notices.push(`WARN: Failed to transition org item ${task.orgItemId} to DOING: ${msg}`);
			}
		}
		if (task.status === "completed" && oldStatus !== "completed" && task.orgItemClosingId) {
			try {
				const result = await transitionOrgItemIfNeeded(projectRoot, todoKeywords, task.orgItemClosingId, "DONE");
				if (result === "transitioned") {
					notices.push(`INFO: Org item ${task.orgItemClosingId} auto-transitioned to DONE.`);
				} else if (result === "not-found") {
					notices.push(`WARN: Org item ${task.orgItemClosingId} not found for DONE transition.`);
				}
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				logger.error("todo_write: failed to auto-transition org item to DONE", {
					error,
					orgItemId: task.orgItemClosingId,
				});
				notices.push(`WARN: Failed to transition org item ${task.orgItemClosingId} to DONE: ${msg}`);
			}
		}
	}
	return notices;
}

/** Resolve a blocker ref against the current todo state, supporting bare slugs and full URIs. */
function resolveTaskRef(ref: string, allTasks: TodoItem[], context: ResolvedTodoContext): TodoItem | undefined {
	const direct = allTasks.find(task => task.id === ref || task.uri === ref);
	if (direct) return direct;
	const resolved = resolveTaskUri(ref, context);
	if (!resolved) return undefined;
	const canonical = buildTaskUri(resolved);
	return allTasks.find(task => task.uri === canonical || task.id === resolved.slug);
}

function hydrateTasks(phases: TodoPhase[], context: ResolvedTodoContext): TodoItem[] {
	const tasks = flattenTasks(phases);
	for (const task of tasks) {
		task.kind ??= "work";
		task.uri = buildTodoUri(task, context);
		if (task.children?.length) {
			for (const child of task.children) {
				child.kind ??= "work";
				child.uri = buildTodoUri(child, context);
			}
		}
	}
	return tasks;
}

function buildTodoDag(phases: TodoPhase[], context: ResolvedTodoContext): MutableDag<TodoItem> {
	const tasks = hydrateTasks(phases, context);
	const entries = tasks.map(
		task =>
			[
				task.uri!,
				task,
				(task.blockers ?? [])
					.map(ref => resolveTaskRef(ref, tasks, context)?.uri)
					.filter((uri): uri is string => uri !== undefined),
			] as [string, TodoItem, string[]],
	);
	return new MutableDag(entries);
}

/**
 * Check if a task has any blocker that is not yet completed or abandoned.
 * Missing refs are treated as resolved for scheduling, but surfaced separately as warnings.
 */
export function hasUnresolvedBlockers(task: TodoItem, allTasks: TodoItem[]): boolean {
	const context: ResolvedTodoContext = { currentSessionId: "current", currentAgentName: "main" };
	if (!task.blockers?.length) return false;
	return task.blockers.some(blockerRef => {
		const blocker =
			resolveTaskRef(blockerRef, allTasks, context) ??
			allTasks.find(t => t.id === blockerRef || t.uri === blockerRef);
		if (!blocker) return false;
		return blocker.status !== "completed" && blocker.status !== "abandoned";
	});
}

/** Check if a task is blocked by unresolved dependencies (pending tasks only). */
export function isTaskBlocked(task: TodoItem, allTasks: TodoItem[]): boolean {
	if (task.status !== "pending") return false;
	return hasUnresolvedBlockers(task, allTasks);
}

export function promoteReadyTasks(
	phases: TodoPhase[],
	isolationMode: boolean,
	context: ResolvedTodoContext = { currentSessionId: "current", currentAgentName: "main" },
): void {
	const tasks = hydrateTasks(phases, context);
	if (tasks.length === 0) return;

	for (const task of tasks) {
		if (
			isSatisfiedDataNode(task) &&
			task.status !== "abandoned" &&
			task.status !== "failed" &&
			task.status !== "gate_failed"
		) {
			task.status = "completed";
		}
	}

	for (const task of tasks) {
		if (task.status === "in_progress" && hasUnresolvedBlockers(task, tasks)) {
			task.status = "pending";
		}
	}

	const filesConflict = (left: TodoItem, right: TodoItem): boolean => {
		const leftFiles = left.filesDeps ?? [];
		const rightFiles = right.filesDeps ?? [];
		if (leftFiles.length === 0 || rightFiles.length === 0) return true;
		const rightSet = new Set(rightFiles);
		return leftFiles.some(file => rightSet.has(file));
	};

	const initialDirectRunning = tasks.filter(
		task => task.status === "in_progress" && !isDelegatedTask(task) && (task.kind ?? "work") === "work",
	);
	const keptRunning: TodoItem[] = [];
	for (const task of initialDirectRunning) {
		const canKeep =
			keptRunning.length === 0 ||
			(isolationMode && task.filesDeps?.length && keptRunning.every(activeTask => !filesConflict(task, activeTask)));
		if (canKeep) {
			keptRunning.push(task);
			continue;
		}
		task.status = "pending";
	}
	if (!isolationMode && tasks.some(task => task.status === "failed" || task.status === "gate_failed")) return;

	const dag = buildTodoDag(phases, context);
	const completed = new Set(
		tasks.filter(task => task.status === "completed" || task.status === "abandoned").map(task => task.uri!),
	);
	const activeUris = new Set(
		tasks.filter(task => task.status === "in_progress" && !isDelegatedTask(task)).map(task => task.uri!),
	);

	const readyUris = dag.getReadyNodeIds(completed).filter(uri => !activeUris.has(uri));
	if (!isolationMode && keptRunning.length > 0) return;

	for (const readyUri of readyUris) {
		const task = tasks.find(candidate => candidate.uri === readyUri);
		if (!task) continue;
		if (task.status !== "pending" || isDelegatedTask(task) || (task.kind ?? "work") !== "work") continue;
		if (isolationMode) {
			const candidateFiles = task.filesDeps ?? [];
			const activeTasks = [...activeUris]
				.map(activeUri => tasks.find(candidate => candidate.uri === activeUri))
				.filter((activeTask): activeTask is TodoItem => activeTask !== undefined);
			const hasOpaqueConflict =
				activeTasks.length > 0 &&
				(candidateFiles.length === 0 || activeTasks.some(activeTask => (activeTask.filesDeps?.length ?? 0) === 0));
			const overlaps = activeTasks.some(activeTask => dag.hasFileOverlap(readyUri, activeTask.uri!));
			if (hasOpaqueConflict || overlaps) continue;
		}
		task.status = "in_progress";
		activeUris.add(readyUri);
		if (!isolationMode) return;
	}
}

function collectBlockerGraphWarnings(phases: TodoPhase[], context: ResolvedTodoContext): string[] {
	const allTasks = hydrateTasks(phases, context);
	const warnings: string[] = [];
	for (const task of allTasks) {
		for (const blockerRef of task.blockers ?? []) {
			if (!resolveTaskRef(blockerRef, allTasks, context)) {
				warnings.push(
					`${task.id} references non-existent blocker ${blockerRef} (dangling blocker is ignored for execution)`,
				);
			}
		}
	}

	const visiting = new Set<string>();
	const visited = new Set<string>();
	const stack: string[] = [];
	const cycleMessages = new Set<string>();
	const visit = (task: TodoItem): void => {
		if (visited.has(task.id)) return;
		if (visiting.has(task.id)) {
			const start = stack.indexOf(task.id);
			if (start >= 0) {
				cycleMessages.add(`Circular blockers detected: ${[...stack.slice(start), task.id].join(" -> ")}`);
			}
			return;
		}
		visiting.add(task.id);
		stack.push(task.id);
		for (const blockerRef of task.blockers ?? []) {
			const blocker = resolveTaskRef(blockerRef, allTasks, context);
			if (blocker) visit(blocker);
		}
		stack.pop();
		visiting.delete(task.id);
		visited.add(task.id);
	};
	for (const task of allTasks) visit(task);
	warnings.push(...cycleMessages);
	return [...new Set(warnings)];
}

export function getLatestTodoPhasesFromEntries(entries: SessionEntry[]): TodoPhase[] {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;

		const message = entry.message as { role?: string; toolName?: string; details?: unknown; isError?: boolean };
		if (message.role !== "toolResult" || message.toolName !== "todo_write" || message.isError) continue;

		const details = message.details as { phases?: unknown } | undefined;
		if (!details || !Array.isArray(details.phases)) continue;

		return cloneTodoPhases(details.phases as TodoPhase[]);
	}

	return [];
}

interface ApplyOpsResult {
	file: TodoFile;
	errors: string[];
	warnings: string[];
	/** Phase IDs that became fully completed in this call. */
	completedPhaseIds: string[];
	/** Tasks that transitioned to completed and have gate fields. */
	completedGatedTasks: TodoItem[];
	/** Tasks whose completion was rejected pending verification. */
	pendingVerificationTasks: TodoItem[];
	/** Tasks whose abandonment was rejected pending deferral follow-up. */
	pendingDeferralTasks: TodoItem[];
}

interface GateVerificationFailure {
	task: TodoItem;
	previousStatus: TodoStatus | undefined;
	failures: GateFailure[];
}

function buildPreviousStatusMap(phases: TodoPhase[]): Map<string, TodoStatus> {
	const previousStatus = new Map<string, TodoStatus>();
	for (const phase of phases) {
		for (const task of phase.tasks) previousStatus.set(task.id, task.status);
	}
	return previousStatus;
}

function collectCompletedPhaseIds(previousPhases: TodoPhase[], nextPhases: TodoPhase[]): string[] {
	const wasComplete = new Map<string, boolean>();
	for (const phase of previousPhases) {
		wasComplete.set(phase.id, isPhaseComplete(phase));
	}

	const completedPhaseIds: string[] = [];
	for (const phase of nextPhases) {
		if (isPhaseComplete(phase) && !wasComplete.get(phase.id)) completedPhaseIds.push(phase.id);
	}
	return completedPhaseIds;
}

function collectCompletedGatedTasks(previousPhases: TodoPhase[], nextPhases: TodoPhase[]): TodoItem[] {
	const previousStatus = buildPreviousStatusMap(previousPhases);
	const completedGatedTasks: TodoItem[] = [];
	for (const phase of nextPhases) {
		for (const task of phase.tasks) {
			if (
				task.status === "completed" &&
				previousStatus.get(task.id) !== "completed" &&
				(hasGate(task) || task.orgItemClosingId)
			) {
				completedGatedTasks.push(task);
			}
		}
	}
	return completedGatedTasks;
}

function isPhaseComplete(phase: TodoPhase): boolean {
	return phase.tasks.length > 0 && phase.tasks.every(t => t.status === "completed" || t.status === "abandoned");
}

export function hasGate(task: TodoItem): boolean {
	return !!(task.gateCommit || task.gateArtifact || task.gateCmd || task.gateLlm || task.verifyCmd);
}

/** Returns true when the task has gates that require two-phase verified completion. */
export function hasRequiredGate(task: TodoItem): boolean {
	return !!(task.gateCommit || task.gateArtifact || task.gateCmd || task.orgItemClosingId);
}

export function applyOps(
	file: TodoFile,
	ops: TodoWriteParams["ops"],
	previousPhases: TodoPhase[],
	policies: TaskPolicy[],
	context: ResolvedTodoContext = { currentSessionId: "current", currentAgentName: "main" },
	isolationMode: boolean = false,
): ApplyOpsResult {
	const errors: string[] = [];
	const warnings: string[] = [];
	const pendingVerificationTasks: TodoItem[] = [];
	const pendingDeferralTasks: TodoItem[] = [];

	for (const op of ops) {
		switch (op.op) {
			case "replace": {
				const next = makeEmptyFile();
				for (const inputPhase of op.phases) {
					const phaseId = `phase-${next.nextPhaseId++}`;
					const { phase, nextTaskId } = buildPhaseFromInput(
						inputPhase,
						phaseId,
						next.nextTaskId,
						policies,
						context,
					);
					next.phases.push(phase);
					next.nextTaskId = nextTaskId;
				}
				file = next;
				break;
			}
			case "add_phase":
			case "add_group": {
				const phaseId = `phase-${file.nextPhaseId++}`;
				const { phase, nextTaskId } = buildPhaseFromInput(op, phaseId, file.nextTaskId, policies, context);
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
				const id = op.slug ?? `task-${file.nextTaskId++}`;
				const task = hydrateTodoItem(
					{
						id,
						uri: op.uri,
						kind: op.kind,
						content: op.content,
						status: "pending",
						notes: op.notes,
						details: op.details,
						filesDeps: op.filesDeps,
						dataContent: op.dataContent,
						artifactPath: op.artifactPath,
						gateCommit: op.gateCommit,
						gateArtifact: op.gateArtifact,
						gateCmd: op.gateCmd,
						gateLlm: op.gateLlm,
						verifyCmd: op.verifyCmd,
						blockers: op.blockers,
						orgItemId: op.orgItemId,
						orgItemClosingId: op.orgItemClosingId,
						delegation: cloneTodoDelegation(op.delegation),
						layer: op.layer,
					},
					context,
				);
				injectPolicyGates(task, policies);
				target.tasks.push(task);
				break;
			}
			case "update": {
				const task = findTask(file.phases, op.id);
				if (!task) {
					errors.push(`Task "${op.id}" not found`);
					break;
				}
				if (op.content !== undefined) task.content = op.content;
				if (op.notes !== undefined) task.notes = op.notes;
				if (op.details !== undefined) task.details = op.details;
				if (op.filesDeps !== undefined) task.filesDeps = [...op.filesDeps];
				if (op.dataContent !== undefined) task.dataContent = op.dataContent;
				if (op.artifactPath !== undefined) task.artifactPath = op.artifactPath;
				if (op.gateCommit !== undefined) task.gateCommit = op.gateCommit;
				if (op.gateArtifact !== undefined) task.gateArtifact = op.gateArtifact;
				if (op.gateCmd !== undefined) task.gateCmd = op.gateCmd;
				if (op.gateLlm !== undefined) task.gateLlm = op.gateLlm;
				if (op.verifyCmd !== undefined) task.verifyCmd = op.verifyCmd;
				if (op.blockers !== undefined) task.blockers = [...op.blockers];
				if (op.orgItemId !== undefined) task.orgItemId = op.orgItemId;
				if (op.orgItemClosingId !== undefined) task.orgItemClosingId = op.orgItemClosingId;
				if (op.delegation !== undefined) task.delegation = cloneTodoDelegation(op.delegation);
				if (op.layer !== undefined) {
					task.layer = op.layer;
					injectPolicyGates(task, policies);
				}
				if (op.status === "in_progress") {
					const allTasks = hydrateTasks(file.phases, context);
					if (hasUnresolvedBlockers(task, allTasks)) {
						const unresolved = (task.blockers ?? [])
							.map(blockerRef => {
								const blocker = resolveTaskRef(blockerRef, allTasks, context);
								if (!blocker) return null;
								return blocker.status !== "completed" && blocker.status !== "abandoned"
									? `${blocker.id} (${blocker.status})`
									: null;
							})
							.filter((value): value is string => value !== null)
							.join(", ");
						errors.push(`Cannot start ${op.id}: blocked by ${unresolved}`);
						break;
					}
				}
				if (op.status === "completed" && hasRequiredGate(task) && !op.verified) {
					pendingVerificationTasks.push(task);
					break;
				}
				if (op.status === "abandoned" && (!op.deferralFupId || op.deferralFupId.trim() === "")) {
					pendingDeferralTasks.push(task);
					break;
				}
				if (op.deferralFupId) task.deferralFupId = op.deferralFupId;
				if (op.status !== undefined) task.status = op.status;
				break;
			}
		}
	}

	try {
		promoteReadyTasks(file.phases, isolationMode, context);
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}
	warnings.push(...collectBlockerGraphWarnings(file.phases, context));
	const hydratedTasks = hydrateTasks(file.phases, context);
	for (const task of hydratedTasks) {
		if (!task.blockers?.length) continue;
		const pruned = task.blockers.filter(
			blockerRef => resolveTaskRef(blockerRef, hydratedTasks, context) !== undefined,
		);
		if (pruned.length !== task.blockers.length) task.blockers = pruned.length > 0 ? pruned : undefined;
	}

	const completedPhaseIds = collectCompletedPhaseIds(previousPhases, file.phases);
	const completedGatedTasks = collectCompletedGatedTasks(previousPhases, file.phases);

	return {
		file,
		errors,
		warnings,
		completedPhaseIds,
		completedGatedTasks,
		pendingVerificationTasks,
		pendingDeferralTasks,
	};
}

/** Build gate directive lines for a single task. */
function gateDirectivesForTask(task: TodoItem): string[] {
	const lines: string[] = [];
	if (task.gateCommit) lines.push(`REQUIRED: Commit your changes for ${task.id} (${task.content}) before proceeding.`);
	if (task.gateArtifact) lines.push(`REQUIRED: Verify artifact exists at ${task.gateArtifact} for ${task.id}.`);
	if (task.gateCmd) lines.push(`REQUIRED: Run \`${task.gateCmd}\` to verify ${task.id}.`);
	if (task.gateLlm) lines.push(`ADVISORY: Review ${task.id} against acceptance criteria: ${task.gateLlm}`);
	if (task.verifyCmd) lines.push(`RECOMMENDED: Run \`${task.verifyCmd}\` to verify ${task.id}.`);
	return lines;
}

export interface FormatSummaryOptions {
	phases: TodoPhase[];
	errors: string[];
	warnings?: string[];
	completedPhaseIds: string[];
	completedGatedTasks: TodoItem[];
	/** Tasks whose completion was rejected pending verification. */
	pendingVerificationTasks: TodoItem[];
	/** Tasks whose verified completion failed against observed session evidence. */
	gateVerificationFailures?: GateVerificationFailure[];
	/** Tasks whose abandonment was rejected pending deferral follow-up. */
	pendingDeferralTasks: TodoItem[];
}

function formatTaskContent(task: TodoItem): string {
	return isDelegatedTask(task) ? `${task.content} [delegated]` : task.content;
}
export function formatSummary({
	phases,
	errors,
	warnings = [],
	completedPhaseIds,
	completedGatedTasks,
	pendingVerificationTasks,
	gateVerificationFailures = [],
	pendingDeferralTasks,
}: FormatSummaryOptions): string {
	const allTasks = phases.flatMap(p => p.tasks);
	if (allTasks.length === 0)
		return [
			errors.length > 0 ? `Errors: ${errors.join("; ")}` : "Todo list cleared.",
			...warnings.map(w => `Warnings: ${w}`),
		]
			.filter(Boolean)
			.join("\n");
	const remainingByPhase = phases
		.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.filter(
				task =>
					task.status === "pending" ||
					task.status === "in_progress" ||
					task.status === "failed" ||
					task.status === "gate_failed",
			),
		}))
		.filter(phase => phase.tasks.length > 0);
	const remainingTasks = remainingByPhase.flatMap(phase => phase.tasks.map(task => ({ ...task, phase: phase.name })));

	// Find current phase
	let currentIdx = phases.findIndex(p =>
		p.tasks.some(
			t =>
				t.status === "pending" || t.status === "in_progress" || t.status === "failed" || t.status === "gate_failed",
		),
	);
	if (currentIdx === -1) currentIdx = phases.length - 1;
	const current = phases[currentIdx];
	const done = current.tasks.filter(t => t.status === "completed" || t.status === "abandoned").length;

	const lines: string[] = [];
	if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
	for (const warning of warnings) lines.push(`Warnings: ${warning}`);
	if (remainingTasks.length === 0) {
		lines.push("Remaining items: none.");
	} else {
		const blockedCount = remainingTasks.filter(t => isTaskBlocked(t, allTasks)).length;
		const blockedSuffix = blockedCount > 0 ? `, ${blockedCount} blocked` : "";
		lines.push(`Remaining items (${remainingTasks.length}${blockedSuffix}):`);
		for (const task of remainingTasks) {
			const blocked = isTaskBlocked(task, allTasks);
			const blockerLabel = blocked ? " [blocked]" : "";
			const layerLabel = task.layer ? ` [${task.layer}]` : "";
			lines.push(
				`  - ${task.id} ${formatTaskContent(task)} [${task.status}]${layerLabel}${blockerLabel} (${task.phase})`,
			);
			if (
				(task.status === "in_progress" || task.status === "failed" || task.status === "gate_failed") &&
				task.details
			) {
				for (const line of task.details.split("\n")) lines.push(`      ${line}`);
			}
		}
	}
	// Deadlock warning: all remaining tasks are blocked and none in_progress
	const hasInProgress = allTasks.some(t => t.status === "in_progress");
	if (!hasInProgress && remainingTasks.length > 0 && remainingTasks.every(t => isTaskBlocked(t, allTasks))) {
		lines.push(
			"WARNING: All remaining tasks are blocked. No task can be started. Review blockers or complete/abandon a blocking task.",
		);
	}

	const blockedInPhase = current.tasks.filter(t => isTaskBlocked(t, allTasks)).length;
	const phaseBlockedSuffix = blockedInPhase > 0 ? `, ${blockedInPhase} blocked` : "";
	lines.push(
		`Phase ${currentIdx + 1}/${phases.length} "${current.name}" \u2014 ${done}/${current.tasks.length} tasks complete${phaseBlockedSuffix}`,
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
							: task.status === "failed" || task.status === "gate_failed"
								? "!"
								: blocked
									? "⛔"
									: "○";
			lines.push(`    ${sym} ${task.id} ${formatTaskContent(task)}`);
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

	if (remainingTasks.some(task => task.status === "gate_failed")) {
		lines.push("");
		lines.push("--- Gate Failures ---");
		for (const task of remainingTasks) {
			if (task.status !== "gate_failed") continue;
			const gateFailures = task.delegation?.result?.gateFailures ?? [];
			if (gateFailures.length === 0) {
				lines.push(`gate_failed: ${task.id} "${task.content}" — verification gates were not satisfied`);
				continue;
			}
			for (const failure of gateFailures) {
				const childPrefix = failure.taskId ? `child ${failure.taskId}: ` : "";
				lines.push(
					`gate_failed: ${task.id} "${task.content}" — ${childPrefix}${failure.gate} not satisfied: expected \`${failure.expected}\`, ${failure.detail}`,
				);
			}
		}
	}

	// Phase completion aggregate directives
	if (completedPhaseIds.length > 0) {
		for (const phaseId of completedPhaseIds) {
			const phase = phases.find(p => p.id === phaseId);
			if (!phase) continue;
			const gatedInPhase = phase.tasks.filter(t => hasGate(t) || t.orgItemClosingId);
			if (gatedInPhase.length === 0) continue;
			const actions: string[] = [];
			if (gatedInPhase.some(t => t.gateCommit)) actions.push("Commit changes.");
			if (gatedInPhase.some(t => t.gateArtifact)) actions.push("Verify artifacts.");
			if (gatedInPhase.some(t => t.gateCmd || t.verifyCmd)) actions.push("Run verification commands.");
			lines.push(`\nPhase "${phase.name}" complete. ${actions.join(" ")}`);
			const deferredInPhase = phase.tasks.filter(t => t.status === "abandoned" && t.deferralFupId);
			if (deferredInPhase.length > 0) {
				const fupRefs = deferredInPhase.map(t => `${t.id} -> ${t.deferralFupId}`).join(", ");
				lines.push(`WARNING: Phase "${phase.name}" has deferred tasks: ${fupRefs}`);
			}
		}
	}

	// Two-phase verification checklist for tasks that need verification before completion
	if (pendingVerificationTasks.length > 0) {
		lines.push("");
		lines.push("--- Verification Required ---");
		for (const task of pendingVerificationTasks) {
			lines.push(`${task.id} "${task.content}" requires verification before completion:`);
			if (task.gateCmd) lines.push(`  [ ] Run \`${task.gateCmd}\` (gateCmd)`);
			if (task.gateArtifact) lines.push(`  [ ] Verify artifact at ${task.gateArtifact} (gateArtifact)`);
			if (task.gateCommit) lines.push(`  [ ] Commit changes (gateCommit)`);
			if (task.gateLlm) lines.push(`  [i] Advisory review: ${task.gateLlm} (gateLlm)`);
			if (task.orgItemClosingId)
				lines.push(`  [i] Verified completion will auto-close org item ${task.orgItemClosingId}.`);
			lines.push("");
			lines.push(
				`Complete these steps, then call todo_write with {op: "update", id: "${task.id}", status: "completed", verified: true}.`,
			);
		}
	}

	if (gateVerificationFailures.length > 0) {
		lines.push("");
		lines.push("--- Gate Verification Failed ---");
		for (const failure of gateVerificationFailures) {
			lines.push(`${failure.task.id} "${failure.task.content}" could not be verified:`);
			for (const gateFailure of failure.failures) {
				lines.push(`  - ${gateFailure.gate}: expected \`${gateFailure.expected}\`, ${gateFailure.detail}`);
			}
			lines.push(
				`  Status remains ${failure.previousStatus ?? "pending"}. Fix the missing evidence, then retry with verified: true.`,
			);
		}
	}

	// Deferral rejection: tasks that need a FUP before abandonment
	if (pendingDeferralTasks.length > 0) {
		lines.push("");
		lines.push("--- Deferral Required ---");
		for (const task of pendingDeferralTasks) {
			lines.push(`${task.id} "${task.content}" cannot be abandoned without a follow-up item.`);
			lines.push("");
			lines.push("Step 1: Create a FUP org item:");
			const suggestedTitle = `Follow-up: ${task.content}`;
			const bodyLines = [`Deferred from ${task.id}: ${task.content}`];
			if (task.details) bodyLines.push(`\nOriginal details:\n${task.details}`);
			if (task.orgItemId) bodyLines.push(`\nSource org item: [[id:${task.orgItemId}]]`);
			if (task.orgItemClosingId)
				bodyLines.push(
					`\nWARNING: This task has orgItemClosingId=${task.orgItemClosingId}. The lifecycle obligation transfers to the FUP.`,
				);
			lines.push(`  org create category=followups title="${suggestedTitle}" body="${bodyLines.join("\n")}"`);
			lines.push("");
			lines.push("Step 2: Abandon with the FUP ID:");
			lines.push(
				`  todo_write ops: [{op: "update", id: "${task.id}", status: "abandoned", deferralFupId: "FUP_ID"}]`,
			);
		}
	}

	return lines.join("\n");
}

async function captureDirectWorkBaselines(
	session: ToolSession,
	previousPhases: TodoPhase[],
	nextPhases: TodoPhase[],
): Promise<void> {
	const previousStatuses = buildPreviousStatusMap(previousPhases);
	for (const phase of nextPhases) {
		for (const task of phase.tasks) {
			if (isDelegatedTask(task)) continue;
			if (!task.gateCommit || task.status !== "in_progress") continue;
			if (previousStatuses.get(task.id) === "in_progress") continue;
			task.gitBaseline = session.captureGitBaseline ? await session.captureGitBaseline() : null;
		}
	}
}

async function verifyDirectWorkCompletions(
	session: ToolSession,
	ops: TodoWriteParams["ops"],
	previousPhases: TodoPhase[],
	nextPhases: TodoPhase[],
): Promise<GateVerificationFailure[]> {
	const gateVerificationFailures: GateVerificationFailure[] = [];
	const executions = [...(session.getBashHistory?.() ?? [])];
	const currentStatuses = buildPreviousStatusMap(previousPhases);

	for (const op of ops) {
		if (op.op !== "update") continue;
		const task = findTask(nextPhases, op.id);
		if (!task) continue;
		if (isDelegatedTask(task)) {
			if (op.status !== undefined) currentStatuses.set(task.id, task.status);
			continue;
		}

		if (op.status === "in_progress") {
			currentStatuses.set(task.id, "in_progress");
			continue;
		}

		if (op.status === "completed" && op.verified && hasRequiredGate(task)) {
			const failures = [
				...(
					await verifyGates({
						gateCmd: task.gateCmd,
						gateArtifact: task.gateArtifact,
						executions,
						cwd: session.cwd,
					})
				).failures,
			] as GateFailure[];

			if (task.gateCommit) {
				if (task.gitBaseline === undefined) {
					failures.push({
						gate: "gateCommit",
						expected: "git commit",
						detail: "Git baseline was not captured when the task entered in_progress.",
					});
				} else if (task.gitBaseline === null) {
					failures.push({
						gate: "gateCommit",
						expected: "git commit",
						detail: "Git baseline could not be captured for this task.",
					});
				} else if (!session.compareGitBaseline) {
					failures.push({
						gate: "gateCommit",
						expected: "git commit",
						detail: "Current git state is unavailable for verification.",
					});
				} else {
					const diff = await session.compareGitBaseline(task.gitBaseline);
					if (!diff) {
						failures.push({
							gate: "gateCommit",
							expected: "git commit",
							detail: "Current git state is unavailable for verification.",
						});
					} else if (!diff.headAdvanced) {
						failures.push({
							gate: "gateCommit",
							expected: "git commit",
							detail: "HEAD did not move after the task entered in_progress.",
						});
					}
				}
			}

			if (failures.length > 0) {
				const previousStatus = currentStatuses.get(task.id);
				task.status = previousStatus ?? "pending";
				gateVerificationFailures.push({ task, previousStatus, failures });
				continue;
			}
		}

		if (op.status !== undefined) currentStatuses.set(task.id, task.status);
	}

	return gateVerificationFailures;
}

function firstUnresolvedBlockerUri(
	task: TodoItem,
	allTasks: TodoItem[],
	context: ResolvedTodoContext,
): string | undefined {
	for (const blockerRef of task.blockers ?? []) {
		const blocker = resolveTaskRef(blockerRef, allTasks, context);
		if (!blocker) continue;
		if (blocker.status !== "completed" && blocker.status !== "abandoned") return blocker.uri;
	}
	return undefined;
}

function emitTodoGraphEvents(
	session: ToolSession,
	previousPhases: TodoPhase[],
	nextPhases: TodoPhase[],
	context: ResolvedTodoContext,
): void {
	const eventBus = session.eventBus;
	if (!eventBus) return;
	const previousTasks = hydrateTasks(cloneTodoPhases(previousPhases), context);
	const nextTasks = hydrateTasks(cloneTodoPhases(nextPhases), context);
	const previousByUri = new Map(previousTasks.map(task => [task.uri!, task] as const));
	for (const task of nextTasks) {
		const previousTask = previousByUri.get(task.uri!);
		if (!previousTask) {
			eventBus.emit("todo:task:created", { taskUri: task.uri!, kind: task.kind ?? "work", slug: task.id });
			eventBus.emit("todo:dag:node_added", {
				nodeUri: task.uri!,
				deps: (task.blockers ?? [])
					.map(ref => resolveTaskRef(ref, nextTasks, context)?.uri)
					.filter((uri): uri is string => uri !== undefined),
			});
			if (task.status !== "pending") {
				eventBus.emit("todo:task:status", { taskUri: task.uri!, from: "pending", to: task.status });
			}
			continue;
		}
		if (previousTask.status !== task.status) {
			eventBus.emit("todo:task:status", { taskUri: task.uri!, from: previousTask.status, to: task.status });
		}
		const wasBlocked = firstUnresolvedBlockerUri(previousTask, previousTasks, context);
		const isBlocked = firstUnresolvedBlockerUri(task, nextTasks, context);
		if (!wasBlocked && isBlocked) {
			eventBus.emit("todo:task:blocked", { taskUri: task.uri!, blockerUri: isBlocked });
		} else if (wasBlocked && !isBlocked) {
			eventBus.emit("todo:task:unblocked", { taskUri: task.uri! });
		}
	}
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
		return await queueTodoMutation(this.session, async () => {
			const previousPhases = cloneTodoPhases(this.session.getTodoPhases?.() ?? []);
			const current = fileFromPhases(cloneTodoPhases(previousPhases));
			const activePolicies = this.session.getResolvedTaskPolicies?.() ?? [];
			const context = resolveTodoContext(this.session);
			const isolationMode = Boolean(this.session.settings.get("task.isolation.mode"));
			const {
				file: updated,
				errors,
				warnings,
				pendingVerificationTasks,
				pendingDeferralTasks,
			} = applyOps(current, params.ops, previousPhases, activePolicies, context, isolationMode);
			await captureDirectWorkBaselines(this.session, previousPhases, updated.phases);
			const gateVerificationFailures = await verifyDirectWorkCompletions(
				this.session,
				params.ops,
				previousPhases,
				updated.phases,
			);
			const completedPhaseIds = collectCompletedPhaseIds(previousPhases, updated.phases);
			const completedGatedTasks = collectCompletedGatedTasks(previousPhases, updated.phases);
			const hasReplace = params.ops.some(op => op.op === "replace");
			this.session.setTodoPhases?.(updated.phases, hasReplace ? { reset: true } : undefined);
			const orgLifecycleNotices = await applyOrgLifecycleHooks(this.session, previousPhases, updated.phases);
			emitTodoGraphEvents(this.session, previousPhases, updated.phases, context);
			this.session.eventBus?.emit("todo:change", { phases: updated.phases, groups: updated.phases });
			const storage = this.session.getSessionFile() ? "session" : "memory";

			const sessionId = this.session.getSessionId?.() ?? "default";
			const projectRoot = this.session.cwd ?? getProjectDir();
			void writeJournal(projectRoot, sessionId, updated.phases);

			const summary = formatSummary({
				phases: updated.phases,
				errors,
				warnings,
				completedPhaseIds,
				completedGatedTasks,
				pendingVerificationTasks,
				gateVerificationFailures,
				pendingDeferralTasks,
			});
			const text = orgLifecycleNotices.length > 0 ? `${summary}\n${orgLifecycleNotices.join("\n")}` : summary;

			return {
				content: [
					{
						type: "text",
						text,
					},
				],
				details: { phases: updated.phases, groups: updated.phases, storage },
			};
		});
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
	if (item.layer) badges.push(`[${item.layer}]`);
	if (item.orgItemClosingId) badges.push(`[org-closing: ${item.orgItemClosingId}]`);
	if (item.orgItemId && !item.orgItemClosingId) badges.push(`[org: ${item.orgItemId}]`);
	if (badges.length === 0) return "";
	return ` ${uiTheme.fg("dim", badges.join(" "))}`;
}

function formatTodoLine(item: TodoItem, uiTheme: Theme, prefix: string, allTasks?: TodoItem[]): string {
	const checkbox = uiTheme.checkbox;
	const badges = renderGateBadges(item, uiTheme);
	const content = formatTaskContent(item);

	// Check blocked state (computed, not stored)
	if (allTasks && isTaskBlocked(item, allTasks)) {
		return uiTheme.fg("warning", `${prefix}${checkbox.unchecked} ${content} [blocked]`) + badges;
	}

	switch (item.status) {
		case "completed":
			return uiTheme.fg("success", `${prefix}${checkbox.checked} ${chalk.strikethrough(content)}`) + badges;
		case "in_progress": {
			const main = uiTheme.fg("accent", `${prefix}${checkbox.unchecked} ${content}`) + badges;
			if (!item.details) return main;
			const detailLines = item.details.split("\n").map(l => uiTheme.fg("dim", `${prefix}  ${l}`));
			return [main, ...detailLines].join("\n");
		}
		case "abandoned":
			return uiTheme.fg("error", `${prefix}${checkbox.unchecked} ${chalk.strikethrough(content)}`) + badges;
		case "failed":
			return uiTheme.fg("error", `${prefix}${checkbox.unchecked} ${content}`) + badges;
		case "gate_failed":
			return uiTheme.fg("warning", `${prefix}${checkbox.unchecked} ${content} [gate failed]`) + badges;
		default:
			return uiTheme.fg("dim", `${prefix}${checkbox.unchecked} ${content}`) + badges;
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

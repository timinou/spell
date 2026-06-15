import * as async_hooks from "node:async_hooks";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@spell/pi-agent-core";
import { StringEnum } from "@spell/pi-ai";
import {
	DEFAULT_ORG_CONFIG,
	findItemById,
	resolveCategories,
	updateItemStateInFile,
	writeJournal,
} from "@spell/pi-org";
import type { Component } from "@spell/pi-tui";
import { Text } from "@spell/pi-tui";
import { getProjectDir, logger } from "@spell/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import chalk from "chalk";
import { renderPromptTemplate } from "../config/prompt-templates";
import { applyPolicyGates, type TaskPolicy, type TaskVerify } from "../config/task-policies";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { createWaveSnapshot } from "./wave-snapshot";
import { buildOrgConfig } from "../org/org-plan";
import todoWriteDescription from "../prompts/tools/todo-write.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { resolveArtifactScopeFromArtifactsDir, resolveArtifactScopeFromSessionFile } from "../session/artifacts";
import type { GitBaseline } from "../session/git-baseline";
import type { SessionEntry } from "../session/session-manager";
import { resolveRef } from "../task/ref-resolver";
import { buildTaskUri, resolveTaskUri, type TaskUriContext } from "../swarm/uri";
import { type GateFailure, verifyGates } from "../task/gate-verification";
import { MutableDag } from "../task/mutable-dag";
import { renderStatusLine, renderTreeList } from "../tui";
import { PREVIEW_LIMITS } from "./render-utils";

// =============================================================================
// Types
// =============================================================================

/**
 * Statuses a node can carry. The model may only SET the first four; `failed`
 * and `gate_failed` are system-only outcomes written by the delegation
 * lifecycle (the `task` tool) and never accepted from the model input schema.
 */
export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "failed" | "gate_failed";
export type TodoKind = "work" | "data" | "loop";

/**
 * Verification requirements for a node. Presence of `commit`, `artifact`, or
 * `cmd` makes completion two-phase (must resubmit with `verified: true`).
 * `review` is advisory self-review criteria and never gates completion.
 */
export interface TodoVerify {
	commit?: boolean;
	artifact?: string;
	cmd?: string;
	review?: string;
	/**
	 * Reviewer-swarm gate (FEAT-816): completing this node requires fanning out
	 * `count` parallel `reviewer` agents over the node's diff. Two-phase like
	 * cmd/commit — satisfiable-by-existing: if the diff was already reviewed this
	 * activation, resubmit `verified:true` without re-dispatching.
	 */
	swarm?: { count: number; criteria?: string };
}

export interface TodoDelegationVerification {
	status: "passed" | "failed";
	gateCommit?: boolean;
	gateArtifact?: string;
	gateCmd?: string;
	failures?: Array<{
		taskId?: string;
		gate: string;
		expected: string;
		detail: string;
	}>;
	artifactPath?: string;
}

export interface TodoDelegationResult {
	output?: string;
	error?: string;
	outputPath?: string;
	gateFailures?: Array<{
		taskId?: string;
		gate: string;
		expected: string;
		detail: string;
	}>;
	verification?: TodoDelegationVerification;
}

export interface TodoDelegation {
	sessionId: string;
	transcriptPath?: string;
	agent?: string;
	childNodes?: TodoNode[];
	result?: TodoDelegationResult;
}

/**
 * The single todo unit. Ordering comes from `blockers` (the DAG), never from
 * array position. `group` is a cosmetic label for display clustering only.
 */
export interface TodoNode {
	id: string;
	uri?: string;
	kind?: TodoKind;
	content: string;
	status: TodoStatus;
	/** Cosmetic display label; does not affect scheduling. */
	group?: string;
	notes?: string;
	details?: string;
	filesDeps?: string[];
	dataContent?: string;
	artifactPath?: string;
	children?: TodoNode[];
	/** Verification requirements. `commit|artifact|cmd` gate; `review` advisory. */
	verify?: TodoVerify;
	verificationArtifact?: string;
	blockers?: string[];
	/**
	 * Linkage to a roster id or `org://ITEM-ID` (shape-dispatched by
	 * {@link resolveRef}). `null`/absent = no linkage. Replaces the legacy
	 * `orgItemId`/`orgItemClosingId` pair.
	 */
	ref?: string | null;
	/** When true, completing this node transitions its `org://` ref to DONE. */
	closesRef?: boolean;
	/** FUP org item ID. Required when status=abandoned (deferral tracking). */
	deferralFupId?: string;
	/** Baseline captured when a direct gated node enters in_progress; used for later commit verification. */
	gitBaseline?: GitBaseline | null;
	/** Delegated subagent metadata. Delegated nodes may remain in_progress alongside one direct node. */
	delegation?: TodoDelegation;
	/** Layer for policy-based gate injection. When set, matching policy gates are auto-injected. */
	layer?: string;
	/** Plan item this node belongs to (wave-snapshot machinery). Set by wave seeding, not the model. */
	planItemId?: string;
	/** 1-indexed wave within the plan (wave-snapshot machinery). */
	waveIndex?: number;
}

export interface TodoWriteToolDetails {
	nodes: TodoNode[];
	storage: "session" | "memory";
}

// =============================================================================
// Schema
// =============================================================================

const StatusEnum = StringEnum(["pending", "in_progress", "completed", "abandoned"] as const, {
	description: "Task status (pending → in_progress → completed | abandoned)",
});

const KindEnum = StringEnum(["work", "data"] as const, {
	description: "Todo node kind",
});

const VerifySchema = Type.Object(
	{
		commit: Type.Optional(Type.Boolean({ description: "Require a git commit before completion (gates)." })),
		artifact: Type.Optional(Type.String({ description: "Path to an artifact that must exist (gates)." })),
		cmd: Type.Optional(Type.String({ description: "Command that must pass (gates)." })),
		review: Type.Optional(Type.String({ description: "Advisory self-review criteria (does not gate)." })),
		swarm: Type.Optional(
			Type.Object(
				{
					count: Type.Number({ description: "Number of parallel reviewer agents to fan out over the diff." }),
					criteria: Type.Optional(Type.String({ description: "Per-swarm acceptance criteria for each reviewer." })),
				},
				{ description: "Reviewer-swarm gate: dispatch N reviewers over the node's diff before completion." },
			),
		),
	},
	{ description: "Verification requirements. commit|artifact|cmd|swarm gate completion; review is advisory." },
);

/**
 * One entry in the declarative `tasks` array. All fields optional except the
 * implicit contract: a NEW node (id absent or unknown) must carry `content`.
 * Patches (id matches an existing node) merge only the provided fields.
 */
const DelegationSchema = Type.Object({
	sessionId: Type.String({ description: "Delegated subagent session ID" }),
	transcriptPath: Type.Optional(Type.String({ description: "Transcript path for the delegated subagent session" })),
	agent: Type.Optional(Type.String({ description: "Agent type handling the delegated work" })),
});

const TodoNodeInput = Type.Object({
	id: Type.Optional(
		Type.String({ description: "Stable id. Omit to auto-assign task-N; provide to upsert an existing node." }),
	),
	content: Type.Optional(Type.String({ description: "Short label (5-10 words). Required for a new node." })),
	status: Type.Optional(StatusEnum),
	group: Type.Optional(Type.String({ description: "Cosmetic display label; does not affect ordering." })),
	details: Type.Optional(
		Type.String({ description: "File paths, steps, specifics. Shown only while the node is active." }),
	),
	notes: Type.Optional(Type.String({ description: "Runtime observations." })),
	blockers: Type.Optional(
		Type.Array(Type.String({ description: "Node id that must finish before this one starts." })),
	),
	ref: Type.Optional(
		Type.Union([Type.String(), Type.Null()], {
			description: "Linkage: roster id or org://ITEM-ID. null = no linkage.",
		}),
	),
	closesRef: Type.Optional(
		Type.Boolean({ description: "When true, completing this node closes its org:// ref (DONE)." }),
	),
	verify: Type.Optional(VerifySchema),
	filesDeps: Type.Optional(Type.Array(Type.String({ description: "Files this node mutates (isolation overlap)." }))),
	kind: Type.Optional(KindEnum),
	dataContent: Type.Optional(Type.String({ description: "Inline content satisfying a data node." })),
	artifactPath: Type.Optional(Type.String({ description: "Artifact path satisfying a data node." })),
	layer: Type.Optional(Type.String({ description: "Layer for policy-based gate injection." })),
	verificationArtifact: Type.Optional(
		Type.String({ description: "Path to a durable delegated verification evidence artifact (system-set)." }),
	),
	delegation: Type.Optional(DelegationSchema),
	verified: Type.Optional(
		Type.Boolean({ description: "Set true after verifying all gate requirements. Required to complete a gated node." }),
	),
	deferralFupId: Type.Optional(
		Type.String({ description: "FUP org item ID for deferral. Required when status=abandoned." }),
	),
});

const todoWriteSchema = Type.Object({
	tasks: Type.Array(TodoNodeInput, {
		description: "Desired nodes. Upsert by id; ids absent from the list are left untouched (unless reset).",
	}),
	reset: Type.Optional(
		Type.Boolean({ description: "true = replace the whole roster with `tasks` (initial plan). Omit = merge by id." }),
	),
});

type TodoWriteParams = Static<typeof todoWriteSchema>;
type TodoNodeInputT = Static<typeof TodoNodeInput>;

// =============================================================================
// File format
// =============================================================================

interface TodoFile {
	nodes: TodoNode[];
	nextTaskId: number;
}

// =============================================================================
// State helpers
// =============================================================================

function makeEmptyFile(): TodoFile {
	return { nodes: [], nextTaskId: 1 };
}

export function findNode(nodes: TodoNode[], id: string): TodoNode | undefined {
	return nodes.find(node => node.id === id || node.uri === id);
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
		return {
			currentSessionId: scope.sessionId,
			currentAgentName: scope.agentName,
		};
	}
	return {
		currentSessionId: session.getSessionId?.() ?? "current",
		currentAgentName: "main",
	};
}

function buildTodoUri(node: Pick<TodoNode, "id" | "kind" | "uri">, context: ResolvedTodoContext): string {
	if (node.uri) return node.uri;
	return buildTaskUri({
		scheme: node.kind === "data" ? "data" : "task",
		sessionId: context.currentSessionId,
		agentName: context.currentAgentName,
		slug: node.id,
	});
}

function cloneVerify(verify: TodoVerify | undefined): TodoVerify | undefined {
	return verify ? { ...verify } : undefined;
}

function hydrateTodoNode(node: TodoNode, context: ResolvedTodoContext): TodoNode {
	return {
		...node,
		kind: node.kind ?? "work",
		uri: buildTodoUri(node, context),
		verify: cloneVerify(node.verify),
		filesDeps: node.filesDeps ? [...node.filesDeps] : undefined,
		blockers: node.blockers ? [...node.blockers] : undefined,
		children: node.children ? node.children.map(child => hydrateTodoNode(child, context)) : undefined,
		delegation: cloneTodoDelegation(node.delegation),
	};
}

function isSatisfiedDataNode(node: TodoNode): boolean {
	if ((node.kind ?? "work") !== "data") return false;
	if (node.status === "completed") return true;
	return Boolean(node.dataContent || node.artifactPath || node.delegation?.result?.outputPath);
}

/** Apply the input fields of an entry onto a node (create or patch). */
/** Apply the input fields of an entry onto a node (create or patch). */
function assignNodeFields(node: TodoNode, input: TodoNodeInputT): void {
	if (input.content !== undefined) node.content = input.content;
	if (input.group !== undefined) node.group = input.group;
	if (input.notes !== undefined) node.notes = input.notes;
	if (input.details !== undefined) node.details = input.details;
	if (input.blockers !== undefined) node.blockers = [...input.blockers];
	if (input.ref !== undefined) node.ref = input.ref;
	if (input.closesRef !== undefined) node.closesRef = input.closesRef;
	if (input.verify !== undefined) node.verify = { ...input.verify };
	if (input.filesDeps !== undefined) node.filesDeps = [...input.filesDeps];
	if (input.kind !== undefined) node.kind = input.kind;
	if (input.dataContent !== undefined) node.dataContent = input.dataContent;
	if (input.artifactPath !== undefined) node.artifactPath = input.artifactPath;
	if (input.verificationArtifact !== undefined) node.verificationArtifact = input.verificationArtifact;
	if (input.delegation !== undefined) node.delegation = cloneTodoDelegation(input.delegation);
}

export function getNextTodoId(nodes: TodoNode[]): number {
	let maxTaskId = 0;
	for (const node of nodes) {
		const match = /^task-(\d+)$/.exec(node.id);
		if (!match) continue;
		const value = Number.parseInt(match[1], 10);
		if (Number.isFinite(value) && value > maxTaskId) maxTaskId = value;
	}
	return maxTaskId + 1;
}

function fileFromNodes(nodes: TodoNode[]): TodoFile {
	return { nodes, nextTaskId: getNextTodoId(nodes) };
}

function cloneTodoDelegation(delegation: TodoDelegation | undefined): TodoDelegation | undefined {
	if (!delegation) return undefined;
	return {
		...delegation,
		childNodes: delegation.childNodes ? cloneTodoNodes(delegation.childNodes) : undefined,
		result: delegation.result
			? {
					...delegation.result,
					gateFailures: delegation.result.gateFailures
						? delegation.result.gateFailures.map(failure => ({ ...failure }))
						: undefined,
					verification: delegation.result.verification
						? {
								...delegation.result.verification,
								failures: delegation.result.verification.failures
									? delegation.result.verification.failures.map(failure => ({ ...failure }))
									: undefined,
							}
						: undefined,
				}
			: undefined,
	};
}

function cloneTodoNode(node: TodoNode): TodoNode {
	return {
		...node,
		verify: cloneVerify(node.verify),
		blockers: node.blockers ? [...node.blockers] : undefined,
		filesDeps: node.filesDeps ? [...node.filesDeps] : undefined,
		children: node.children ? node.children.map(child => cloneTodoNode(child)) : undefined,
		delegation: cloneTodoDelegation(node.delegation),
	};
}

export function cloneTodoNodes(nodes: TodoNode[]): TodoNode[] {
	return nodes.map(node => cloneTodoNode(node));
}

export function injectPolicyGates(node: TodoNode, policies: TaskPolicy[]): void {
	if (!node.layer || policies.length === 0) return;
	const resolved = applyPolicyGates(node.verify ?? {}, node.layer, policies);
	if (
		resolved.commit !== undefined ||
		resolved.artifact !== undefined ||
		resolved.cmd !== undefined ||
		resolved.review !== undefined ||
		resolved.swarm !== undefined
	) {
		node.verify = resolved;
	}
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

export function isDelegatedNode(node: TodoNode): boolean {
	return node.delegation !== undefined;
}

// =============================================================================
// Org lifecycle hooks (ref / closesRef)
// =============================================================================

const ORG_DOING_OR_LATER_STATES = new Set(["DOING", "REVIEW", "DONE", "BLOCKED"]);
const ORG_DONE_OR_LATER_STATES = new Set(["DONE", "BLOCKED"]);

type OrgTransitionResult = "transitioned" | "not-found" | "skipped";

/** Org item id targeted by a node ref, if the ref is an org:// shape. */
function orgRefItemId(ref: string | null | undefined): string | undefined {
	const resolved = resolveRef(ref);
	return resolved.kind === "org" ? resolved.itemId : undefined;
}

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
		prefix: category.prefix,
		root: projectRoot,
	}));
	const item = await findItemById(catDirs, orgItemId, todoKeywords);
	if (!item) {
		logger.warn("todo_write: linked org item not found", { orgItemId, targetState });
		return "not-found";
	}
	const skipStates = targetState === "DOING" ? ORG_DOING_OR_LATER_STATES : ORG_DONE_OR_LATER_STATES;
	if (skipStates.has(item.state)) return "skipped";
	const updated = await updateItemStateInFile(item.file, orgItemId, targetState, todoKeywords);
	if (!updated) {
		logger.warn("todo_write: org state transition returned false", { orgItemId, targetState, file: item.file });
		return "skipped";
	}
	return "transitioned";
}

async function applyOrgLifecycleHooks(
	session: ToolSession,
	previousNodes: TodoNode[],
	nextNodes: TodoNode[],
): Promise<string[]> {
	if (!session.settings.get("org.enabled")) return [];
	const projectRoot = session.cwd ?? getProjectDir();
	const todoKeywords = [...buildOrgConfig(session.settings).todoKeywords];
	const previousStatus = new Map(previousNodes.map(node => [node.id, node.status]));
	const notices: string[] = [];
	for (const node of nextNodes) {
		const orgItemId = orgRefItemId(node.ref);
		if (!orgItemId) continue;
		const oldStatus = previousStatus.get(node.id);
		if (node.status === "in_progress" && oldStatus !== "in_progress") {
			try {
				const result = await transitionOrgItemIfNeeded(projectRoot, todoKeywords, orgItemId, "DOING");
				if (result === "transitioned") notices.push(`INFO: Org item ${orgItemId} auto-transitioned to DOING.`);
				else if (result === "not-found") notices.push(`WARN: Org item ${orgItemId} not found for DOING transition.`);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				logger.error("todo_write: failed to auto-transition org item to DOING", { error, orgItemId });
				notices.push(`WARN: Failed to transition org item ${orgItemId} to DOING: ${msg}`);
			}
		}
		if (node.status === "completed" && oldStatus !== "completed" && node.closesRef) {
			try {
				const result = await transitionOrgItemIfNeeded(projectRoot, todoKeywords, orgItemId, "DONE");
				if (result === "transitioned") notices.push(`INFO: Org item ${orgItemId} auto-transitioned to DONE.`);
				else if (result === "not-found") notices.push(`WARN: Org item ${orgItemId} not found for DONE transition.`);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				logger.error("todo_write: failed to auto-transition org item to DONE", { error, orgItemId });
				notices.push(`WARN: Failed to transition org item ${orgItemId} to DONE: ${msg}`);
			}
		}
	}
	return notices;
}

// =============================================================================
// DAG / scheduling
// =============================================================================

/** Resolve a blocker ref against current nodes, supporting bare ids and URIs. */
function resolveNodeRef(ref: string, allNodes: TodoNode[], context: ResolvedTodoContext): TodoNode | undefined {
	const direct = allNodes.find(node => node.id === ref || node.uri === ref);
	if (direct) return direct;
	const resolved = resolveTaskUri(ref, context);
	if (!resolved) return undefined;
	const canonical = buildTaskUri(resolved);
	return allNodes.find(node => node.uri === canonical || node.id === resolved.slug);
}

function hydrateNodes(nodes: TodoNode[], context: ResolvedTodoContext): TodoNode[] {
	for (const node of nodes) {
		node.kind ??= "work";
		node.uri = buildTodoUri(node, context);
		if (node.children?.length) {
			for (const child of node.children) {
				child.kind ??= "work";
				child.uri = buildTodoUri(child, context);
			}
		}
	}
	return nodes;
}

function buildTodoDag(nodes: TodoNode[], context: ResolvedTodoContext): MutableDag<TodoNode> {
	hydrateNodes(nodes, context);
	const entries = nodes.map(
		node =>
			[
				node.uri!,
				node,
				(node.blockers ?? [])
					.map(ref => resolveNodeRef(ref, nodes, context)?.uri)
					.filter((uri): uri is string => uri !== undefined),
			] as [string, TodoNode, string[]],
	);
	return new MutableDag(entries);
}

export function hasUnresolvedBlockers(
	node: TodoNode,
	allNodes: TodoNode[],
	context: ResolvedTodoContext = { currentSessionId: "current", currentAgentName: "main" },
): boolean {
	if (!node.blockers?.length) return false;
	return node.blockers.some(blockerRef => {
		const blocker =
			resolveNodeRef(blockerRef, allNodes, context) ??
			allNodes.find(n => n.id === blockerRef || n.uri === blockerRef);
		if (!blocker) return false;
		return blocker.status !== "completed" && blocker.status !== "abandoned";
	});
}

/**
 * Wave depth per non-terminal node = topological level in the blocker DAG.
 *
 * A node whose blockers are all terminal (completed/abandoned) sits at wave 1
 * (ready now); each unmet blocker pushes a dependent one wave deeper. Terminal
 * nodes are excluded. Pure longest-path over *incomplete* blockers — surfaces
 * how many sequential rounds of work remain and which nodes can run in parallel.
 */
export function computeWaveDepths(
	nodes: TodoNode[],
	context: ResolvedTodoContext = { currentSessionId: "current", currentAgentName: "main" },
): Map<string, number> {
	const isTerminal = (node: TodoNode): boolean =>
		node.status === "completed" || node.status === "abandoned";
	const byId = new Map<string, TodoNode>();
	for (const node of nodes) byId.set(node.id, node);
	const depths = new Map<string, number>();
	const visiting = new Set<string>();
	const resolve = (ref: string): TodoNode | undefined =>
		resolveNodeRef(ref, nodes, context) ?? byId.get(ref);
	const depthOf = (node: TodoNode): number => {
		if (isTerminal(node)) return 0;
		const cached = depths.get(node.id);
		if (cached !== undefined) return cached;
		if (visiting.has(node.id)) return 1; // cycle guard — treat as ready
		visiting.add(node.id);
		let maxBlocker = 0;
		for (const ref of node.blockers ?? []) {
			const blocker = resolve(ref);
			if (!blocker || isTerminal(blocker)) continue;
			maxBlocker = Math.max(maxBlocker, depthOf(blocker));
		}
		visiting.delete(node.id);
		const depth = maxBlocker + 1;
		depths.set(node.id, depth);
		return depth;
	};
	for (const node of nodes) if (!isTerminal(node)) depthOf(node);
	return depths;
}
export function isNodeBlocked(
	node: TodoNode,
	allNodes: TodoNode[],
	context: ResolvedTodoContext = { currentSessionId: "current", currentAgentName: "main" },
): boolean {
	if (node.status !== "pending") return false;
	return hasUnresolvedBlockers(node, allNodes, context);
}

export function promoteReadyNodes(
	nodes: TodoNode[],
	isolationMode: boolean,
	context: ResolvedTodoContext = { currentSessionId: "current", currentAgentName: "main" },
): void {
	hydrateNodes(nodes, context);
	if (nodes.length === 0) return;

	for (const node of nodes) {
		if (
			isSatisfiedDataNode(node) &&
			node.status !== "abandoned" &&
			node.status !== "failed" &&
			node.status !== "gate_failed"
		) {
			node.status = "completed";
		}
	}

	for (const node of nodes) {
		if (node.status === "in_progress" && hasUnresolvedBlockers(node, nodes, context)) {
			node.status = "pending";
		}
	}

	const filesConflict = (left: TodoNode, right: TodoNode): boolean => {
		const leftFiles = left.filesDeps ?? [];
		const rightFiles = right.filesDeps ?? [];
		if (leftFiles.length === 0 || rightFiles.length === 0) return true;
		const rightSet = new Set(rightFiles);
		return leftFiles.some(file => rightSet.has(file));
	};

	const initialDirectRunning = nodes.filter(
		node => node.status === "in_progress" && !isDelegatedNode(node) && (node.kind ?? "work") === "work",
	);
	const keptRunning: TodoNode[] = [];
	for (const node of initialDirectRunning) {
		const canKeep =
			keptRunning.length === 0 ||
			(isolationMode && node.filesDeps?.length && keptRunning.every(active => !filesConflict(node, active)));
		if (canKeep) {
			keptRunning.push(node);
			continue;
		}
		node.status = "pending";
	}
	if (!isolationMode && nodes.some(node => node.status === "failed" || node.status === "gate_failed")) return;

	const dag = buildTodoDag(nodes, context);
	const completed = new Set(
		nodes.filter(node => node.status === "completed" || node.status === "abandoned").map(node => node.uri!),
	);
	const activeUris = new Set(
		nodes.filter(node => node.status === "in_progress" && !isDelegatedNode(node)).map(node => node.uri!),
	);

	const readyUris = dag.getReadyNodeIds(completed).filter(uri => !activeUris.has(uri));
	if (!isolationMode && keptRunning.length > 0) return;

	for (const readyUri of readyUris) {
		const node = nodes.find(candidate => candidate.uri === readyUri);
		if (!node) continue;
		if (node.status !== "pending" || isDelegatedNode(node) || (node.kind ?? "work") !== "work") continue;
		if (isolationMode) {
			const candidateFiles = node.filesDeps ?? [];
			const activeNodes = [...activeUris]
				.map(activeUri => nodes.find(candidate => candidate.uri === activeUri))
				.filter((active): active is TodoNode => active !== undefined);
			const hasOpaqueConflict =
				activeNodes.length > 0 &&
				(candidateFiles.length === 0 || activeNodes.some(active => (active.filesDeps?.length ?? 0) === 0));
			const overlaps = activeNodes.some(active => dag.hasFileOverlap(readyUri, active.uri!));
			if (hasOpaqueConflict || overlaps) continue;
		}
		node.status = "in_progress";
		activeUris.add(readyUri);
		if (!isolationMode) return;
	}
}

function collectBlockerGraphWarnings(nodes: TodoNode[], context: ResolvedTodoContext): string[] {
	hydrateNodes(nodes, context);
	const warnings: string[] = [];
	for (const node of nodes) {
		for (const blockerRef of node.blockers ?? []) {
			if (!resolveNodeRef(blockerRef, nodes, context)) {
				warnings.push(
					`${node.id} references non-existent blocker ${blockerRef} (dangling blocker is ignored for execution)`,
				);
			}
		}
	}

	const visiting = new Set<string>();
	const visited = new Set<string>();
	const stack: string[] = [];
	const cycleMessages = new Set<string>();
	const visit = (node: TodoNode): void => {
		if (visited.has(node.id)) return;
		if (visiting.has(node.id)) {
			const start = stack.indexOf(node.id);
			if (start >= 0) cycleMessages.add(`Circular blockers detected: ${[...stack.slice(start), node.id].join(" -> ")}`);
			return;
		}
		visiting.add(node.id);
		stack.push(node.id);
		for (const blockerRef of node.blockers ?? []) {
			const blocker = resolveNodeRef(blockerRef, nodes, context);
			if (blocker) visit(blocker);
		}
		stack.pop();
		visiting.delete(node.id);
		visited.add(node.id);
	};
	for (const node of nodes) visit(node);
	warnings.push(...cycleMessages);
	return [...new Set(warnings)];
}

/**
 * Recover the latest flat node roster from a persisted tool result. Hard-break
 * migration (D6): legacy group-shaped results return [] (the session re-plans).
 */
export function getLatestTodoNodesFromEntries(entries: SessionEntry[]): TodoNode[] {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; toolName?: string; details?: unknown; isError?: boolean };
		if (message.role !== "toolResult" || message.toolName !== "todo_write" || message.isError) continue;
		const details = message.details as { nodes?: unknown } | undefined;
		const storedNodes = details?.nodes;
		if (!Array.isArray(storedNodes)) return [];
		return cloneTodoNodes(storedNodes as TodoNode[]);
	}
	return [];
}

// =============================================================================
// Reconcile (apply)
// =============================================================================

interface ApplyResult {
	file: TodoFile;
	errors: string[];
	warnings: string[];
	/** Group labels that became fully completed in this call. */
	completedGroups: string[];
	/** Nodes that transitioned to completed and carry gates. */
	completedGatedNodes: TodoNode[];
	/** Nodes whose completion was rejected pending verification. */
	pendingVerificationNodes: TodoNode[];
	/** Nodes whose abandonment was rejected pending deferral follow-up. */
	pendingDeferralNodes: TodoNode[];
}

interface GateVerificationFailure {
	node: TodoNode;
	previousStatus: TodoStatus | undefined;
	failures: GateFailure[];
}

function buildPreviousStatusMap(nodes: TodoNode[]): Map<string, TodoStatus> {
	const previousStatus = new Map<string, TodoStatus>();
	for (const node of nodes) previousStatus.set(node.id, node.status);
	return previousStatus;
}

/** Group nodes by their (non-empty) cosmetic label, preserving first-seen order. */
function groupsByLabel(nodes: TodoNode[]): Map<string, TodoNode[]> {
	const map = new Map<string, TodoNode[]>();
	for (const node of nodes) {
		const label = node.group?.trim();
		if (!label) continue;
		const bucket = map.get(label);
		if (bucket) bucket.push(node);
		else map.set(label, [node]);
	}
	return map;
}

function isGroupComplete(nodes: TodoNode[]): boolean {
	return nodes.length > 0 && nodes.every(n => n.status === "completed" || n.status === "abandoned");
}

function collectCompletedGroups(previousNodes: TodoNode[], nextNodes: TodoNode[]): string[] {
	const before = groupsByLabel(previousNodes);
	const after = groupsByLabel(nextNodes);
	const completed: string[] = [];
	for (const [label, group] of after) {
		const wasComplete = before.has(label) ? isGroupComplete(before.get(label)!) : false;
		if (isGroupComplete(group) && !wasComplete) completed.push(label);
	}
	return completed;
}

function collectCompletedGatedNodes(previousNodes: TodoNode[], nextNodes: TodoNode[]): TodoNode[] {
	const previousStatus = buildPreviousStatusMap(previousNodes);
	const out: TodoNode[] = [];
	for (const node of nextNodes) {
		if (node.status === "completed" && previousStatus.get(node.id) !== "completed" && (hasGate(node) || node.closesRef)) {
			out.push(node);
		}
	}
	return out;
}

/** Wave-snapshot requests when a plan wave just completed (dormant until wave seeding sets planItemId/waveIndex). */
function collectWaveSnapshotRequests(
	previousNodes: TodoNode[],
	nextNodes: TodoNode[],
): Array<{ planItemId: string; waveIndex: number; ref: string }> {
	const wavesOf = (nodes: TodoNode[]): Map<string, TodoNode[]> => {
		const map = new Map<string, TodoNode[]>();
		for (const node of nodes) {
			if (!node.planItemId || !node.waveIndex) continue;
			const key = `${node.planItemId}#${node.waveIndex}`;
			const bucket = map.get(key);
			if (bucket) bucket.push(node);
			else map.set(key, [node]);
		}
		return map;
	};
	const before = wavesOf(previousNodes);
	const after = wavesOf(nextNodes);
	const requests = new Map<string, { planItemId: string; waveIndex: number; ref: string }>();
	for (const node of nextNodes) {
		const currentWaveIndex = node.waveIndex;
		if (!node.planItemId || !currentWaveIndex || currentWaveIndex <= 1) continue;
		const key = `${node.planItemId}#${currentWaveIndex}`;
		const hadInProgress = (before.get(key) ?? []).some(n => n.status === "in_progress");
		const hasInProgress = (after.get(key) ?? []).some(n => n.status === "in_progress");
		if (!hasInProgress || hadInProgress) continue;
		const completedKey = `${node.planItemId}#${currentWaveIndex - 1}`;
		const completedWave = after.get(completedKey);
		if (!completedWave || !isGroupComplete(completedWave)) continue;
		const ref = `refs/spell/plan/${node.planItemId}/wave-${currentWaveIndex - 1}`;
		requests.set(ref, { planItemId: node.planItemId, waveIndex: currentWaveIndex - 1, ref });
	}
	return [...requests.values()];
}

export function hasGate(node: TodoNode): boolean {
	const v = node.verify;
	return !!(v && (v.commit || v.artifact || v.cmd || v.review || v.swarm));
}

/** True when the node has gates that require two-phase verified completion. */
export function hasRequiredGate(node: TodoNode): boolean {
	const v = node.verify;
	return !!((v && (v.commit || v.artifact || v.cmd || v.swarm)) || node.closesRef);
}

/**
 * Reconcile the desired `tasks` onto the current file. Upsert by id; `reset`
 * replaces the whole roster. Returns the new file plus the side-channel lists
 * the summary renders.
 */
export function applyReconcile(
	file: TodoFile,
	params: TodoWriteParams,
	previousNodes: TodoNode[],
	policies: TaskPolicy[],
	context: ResolvedTodoContext = { currentSessionId: "current", currentAgentName: "main" },
	isolationMode: boolean = false,
): ApplyResult {
	const errors: string[] = [];
	const warnings: string[] = [];
	const pendingVerificationNodes: TodoNode[] = [];
	const pendingDeferralNodes: TodoNode[] = [];

	if (params.reset) {
		file = makeEmptyFile();
	}

	for (const input of params.tasks) {
		const existing = input.id ? findNode(file.nodes, input.id) : undefined;

		if (!existing) {
			// Create. content required.
			if (input.content === undefined || input.content.trim() === "") {
				errors.push(input.id ? `Task "${input.id}" not found and no content given to create it.` : "New task requires content.");
				continue;
			}
			const id = input.id ?? `task-${file.nextTaskId++}`;
			const node = hydrateTodoNode(
				{ id, content: input.content, status: "pending" },
				context,
			);
			assignNodeFields(node, input);
			node.layer = input.layer;
			injectPolicyGates(node, policies);
			applyStatusTransition(node, input, file.nodes, context, policies, {
				errors,
				pendingVerificationNodes,
				pendingDeferralNodes,
			});
			file.nodes.push(node);
			continue;
		}

		// Patch existing.
		assignNodeFields(existing, input);
		if (input.layer !== undefined) {
			existing.layer = input.layer;
			injectPolicyGates(existing, policies);
		}
		applyStatusTransition(existing, input, file.nodes, context, policies, {
			errors,
			pendingVerificationNodes,
			pendingDeferralNodes,
		});
	}

	try {
		promoteReadyNodes(file.nodes, isolationMode, context);
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}
	warnings.push(...collectBlockerGraphWarnings(file.nodes, context));
	hydrateNodes(file.nodes, context);
	for (const node of file.nodes) {
		if (!node.blockers?.length) continue;
		const pruned = node.blockers.filter(ref => resolveNodeRef(ref, file.nodes, context) !== undefined);
		if (pruned.length !== node.blockers.length) node.blockers = pruned.length > 0 ? pruned : undefined;
	}

	const completedGroups = collectCompletedGroups(previousNodes, file.nodes);
	const completedGatedNodes = collectCompletedGatedNodes(previousNodes, file.nodes);

	return { file, errors, warnings, completedGroups, completedGatedNodes, pendingVerificationNodes, pendingDeferralNodes };
}

interface TransitionSinks {
	errors: string[];
	pendingVerificationNodes: TodoNode[];
	pendingDeferralNodes: TodoNode[];
}

/** Apply a status change with blocker/verification/deferral guards. */
function applyStatusTransition(
	node: TodoNode,
	input: TodoNodeInputT,
	allNodes: TodoNode[],
	context: ResolvedTodoContext,
	_policies: TaskPolicy[],
	sinks: TransitionSinks,
): void {
	if (input.status === undefined) {
		if (input.deferralFupId) node.deferralFupId = input.deferralFupId;
		return;
	}

	if (input.status === "in_progress") {
		if (hasUnresolvedBlockers(node, allNodes, context)) {
			const unresolved = (node.blockers ?? [])
				.map(blockerRef => {
					const blocker = resolveNodeRef(blockerRef, allNodes, context);
					if (!blocker) return null;
					return blocker.status !== "completed" && blocker.status !== "abandoned"
						? `${blocker.id} (${blocker.status})`
						: null;
				})
				.filter((value): value is string => value !== null)
				.join(", ");
			sinks.errors.push(`Cannot start ${node.id}: blocked by ${unresolved}`);
			return;
		}
	}

	if (input.status === "completed" && hasRequiredGate(node) && !input.verified) {
		sinks.pendingVerificationNodes.push(node);
		return;
	}

	if (input.status === "abandoned" && (!input.deferralFupId || input.deferralFupId.trim() === "")) {
		sinks.pendingDeferralNodes.push(node);
		return;
	}

	if (input.deferralFupId) node.deferralFupId = input.deferralFupId;
	node.status = input.status;
}

// =============================================================================
// Summary formatting
// =============================================================================

/** Build gate directive lines for a single node. */
/**
 * Build confirmatory receipt lines for a completed gated node.
 *
 * By the time a node reaches this section it has already cleared its gates:
 * required gates (cmd/artifact/commit/closesRef) passed the two-phase
 * `verified:true` guard in {@link applyStatusTransition}, and `closesRef`
 * auto-transitioned its org item to DONE. The voice is therefore a receipt,
 * not an imperative — the imperative checklist lives in "Verification
 * Required" (pending) only. Advisory review is the lone non-gating signal and
 * is surfaced as a reminder.
 */
function gateDirectivesForNode(node: TodoNode): string[] {
	const v = node.verify;
	const cleared: string[] = [];
	if (v?.cmd) cleared.push("verify.cmd");
	if (v?.artifact) cleared.push("verify.artifact");
	if (v?.commit) cleared.push("verify.commit");
	if (v?.swarm) cleared.push("verify.swarm");
	if (node.closesRef) cleared.push(`closes ${node.ref ?? "ref"}`);
	const lines: string[] = [];
	if (cleared.length > 0) lines.push(`✓ ${node.id} cleared: ${cleared.join(", ")}.`);
	if (v?.review) lines.push(`  ↳ ${node.id} advisory review: ${v.review} (verify.review).`);
	return lines;
}

export interface FormatSummaryOptions {
	nodes: TodoNode[];
	errors: string[];
	warnings?: string[];
	completedGroups: string[];
	completedGatedNodes: TodoNode[];
	pendingVerificationNodes: TodoNode[];
	gateVerificationFailures?: GateVerificationFailure[];
	pendingDeferralNodes: TodoNode[];
}

function formatNodeContent(node: TodoNode): string {
	return isDelegatedNode(node) ? `${node.content} [delegated]` : node.content;
}

const ACTIVE_STATUSES = new Set<TodoStatus>(["pending", "in_progress", "failed", "gate_failed"]);

export function formatSummary({
	nodes,
	errors,
	warnings = [],
	completedGroups,
	completedGatedNodes,
	pendingVerificationNodes,
	gateVerificationFailures = [],
	pendingDeferralNodes,
}: FormatSummaryOptions): string {
	if (nodes.length === 0) {
		return [
			errors.length > 0 ? `Errors: ${errors.join("; ")}` : "Todo list cleared.",
			...warnings.map(warning => `Warnings: ${warning}`),
		]
			.filter(Boolean)
			.join("\n");
	}

	const remaining = nodes.filter(node => ACTIVE_STATUSES.has(node.status));
	const lines: string[] = [];
	if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
	for (const warning of warnings) lines.push(`Warnings: ${warning}`);

	if (remaining.length === 0) {
		lines.push("Remaining items: none.");
	} else {
		const blockedCount = remaining.filter(node => isNodeBlocked(node, nodes)).length;
		const blockedSuffix = blockedCount > 0 ? `, ${blockedCount} blocked` : "";
		lines.push(`Remaining items (${remaining.length}${blockedSuffix}):`);
		for (const node of remaining) {
			const blocked = isNodeBlocked(node, nodes);
			const blockerLabel = blocked ? " [blocked]" : "";
			const layerLabel = node.layer ? ` [${node.layer}]` : "";
			const groupLabel = node.group ? ` (${node.group})` : "";
			lines.push(`  - ${node.id} ${formatNodeContent(node)} [${node.status}]${layerLabel}${blockerLabel}${groupLabel}`);
			if ((node.status === "in_progress" || node.status === "failed" || node.status === "gate_failed") && node.details) {
				for (const line of node.details.split("\n")) lines.push(`      ${line}`);
			}
		}
	}

	const hasInProgress = nodes.some(node => node.status === "in_progress");
	if (!hasInProgress && remaining.length > 0 && remaining.every(node => isNodeBlocked(node, nodes))) {
		lines.push(
			"WARNING: All remaining tasks are blocked. No task can be started. Review blockers or complete/abandon a blocking task.",
		);
	}

	const total = nodes.length;
	const done = nodes.filter(node => node.status === "completed" || node.status === "abandoned").length;
	lines.push(`Progress: ${done}/${total} complete.`);
	const waveDepths = computeWaveDepths(nodes);
	const maxWave = Math.max(0, ...waveDepths.values());
	if (maxWave >= 2) {
		const readyCount = [...waveDepths.values()].filter(depth => depth === 1).length;
		lines.push(`Waves: ${maxWave} (w1 ready: ${readyCount} parallel).`);
	}
	for (const node of nodes) {
		const blocked = isNodeBlocked(node, nodes);
		const sym =
			node.status === "completed"
				? "✓"
				: node.status === "in_progress"
					? "→"
					: node.status === "abandoned"
						? "✗"
						: node.status === "failed" || node.status === "gate_failed"
							? "!"
							: blocked
								? "⛔"
								: "○";
		const wave = maxWave >= 2 ? waveDepths.get(node.id) : undefined;
		const waveBadge = wave !== undefined ? ` [w${wave}]` : "";
		lines.push(`    ${sym} ${node.id}${waveBadge} ${formatNodeContent(node)}`);
	}

	if (completedGatedNodes.length > 0) {
		lines.push("");
		lines.push("--- Verification Cleared ---");
		for (const node of completedGatedNodes) {
			for (const directive of gateDirectivesForNode(node)) lines.push(directive);
		}
	}

	if (remaining.some(node => node.status === "gate_failed")) {
		lines.push("");
		lines.push("--- Gate Failures ---");
		for (const node of remaining) {
			if (node.status !== "gate_failed") continue;
			const gateFailures = node.delegation?.result?.gateFailures ?? [];
			if (gateFailures.length === 0) {
				lines.push(`gate_failed: ${node.id} "${node.content}" — verification gates were not satisfied`);
				continue;
			}
			for (const failure of gateFailures) {
				const childPrefix = failure.taskId ? `child ${failure.taskId}: ` : "";
				lines.push(
					`gate_failed: ${node.id} "${node.content}" — ${childPrefix}${failure.gate} not satisfied: expected \`${failure.expected}\`, ${failure.detail}`,
				);
			}
		}
	}

	if (completedGroups.length > 0) {
		const byLabel = groupsByLabel(nodes);
		for (const label of completedGroups) {
			const group = byLabel.get(label);
			if (!group) continue;
			const gated = group.filter(node => hasGate(node) || node.closesRef);
			const cleared = gated.length > 0 ? ` ${gated.length} gated node(s) cleared.` : "";
			lines.push(`\nGroup "${label}" complete.${cleared}`);
			const deferred = group.filter(node => node.status === "abandoned" && node.deferralFupId);
			if (deferred.length > 0) {
				const fupRefs = deferred.map(node => `${node.id} -> ${node.deferralFupId}`).join(", ");
				lines.push(`WARNING: Group "${label}" has deferred tasks: ${fupRefs}`);
			}
		}
	}

	if (pendingVerificationNodes.length > 0) {
		lines.push("");
		lines.push("--- Verification Required ---");
		for (const node of pendingVerificationNodes) {
			lines.push(`${node.id} "${node.content}" requires verification before completion:`);
			if (node.verify?.cmd) lines.push(`  [ ] Run \`${node.verify.cmd}\` (verify.cmd)`);
			if (node.verify?.artifact) lines.push(`  [ ] Verify artifact at ${node.verify.artifact} (verify.artifact)`);
			if (node.verify?.commit) lines.push(`  [ ] Commit changes (verify.commit)`);
			if (node.verify?.swarm) {
				const { count, criteria } = node.verify.swarm;
				lines.push(
					`  [ ] Reviewer swarm: dispatch ${count} parallel \`reviewer\` task(s) over this node's diff` +
						`${criteria ? ` (criteria: ${criteria})` : ""}; file findings to org, then resolve them (verify.swarm).` +
						` Already reviewed this wave's diff? It is satisfied — proceed.`,
				);
			}
			if (node.verify?.review) lines.push(`  [i] Advisory review: ${node.verify.review} (verify.review)`);
			if (node.closesRef) lines.push(`  [i] Verified completion will close org ref ${node.ref ?? ""}.`);
			lines.push("");
			lines.push(
				`Complete these steps, then call todo_write with {tasks: [{id: "${node.id}", status: "completed", verified: true}]}.`,
			);
		}
	}

	if (gateVerificationFailures.length > 0) {
		lines.push("");
		lines.push("--- Gate Verification Failed ---");
		for (const failure of gateVerificationFailures) {
			lines.push(`${failure.node.id} "${failure.node.content}" could not be verified:`);
			for (const gateFailure of failure.failures) {
				lines.push(`  - ${gateFailure.gate}: expected \`${gateFailure.expected}\`, ${gateFailure.detail}`);
			}
			const reviewOnly = failure.failures.every(gateFailure => gateFailure.gate === "verify.review");
			lines.push(
				reviewOnly
					? `  Status remains ${failure.previousStatus ?? "in_progress"}. Address the review feedback, then mark completed again.`
					: `  Status remains ${failure.previousStatus ?? "pending"}. Fix the missing evidence, then retry with verified: true.`,
			);
		}
	}

	if (pendingDeferralNodes.length > 0) {
		lines.push("");
		lines.push("--- Deferral Required ---");
		for (const node of pendingDeferralNodes) {
			lines.push(`${node.id} "${node.content}" cannot be abandoned without a follow-up item.`);
			lines.push("");
			lines.push("Step 1: Create a FUP org item:");
			const suggestedTitle = `Follow-up: ${node.content}`;
			const bodyLines = [`Deferred from ${node.id}: ${node.content}`];
			if (node.details) bodyLines.push(`\nOriginal details:\n${node.details}`);
			const orgItemId = orgRefItemId(node.ref);
			if (orgItemId) bodyLines.push(`\nSource org item: [[id:${orgItemId}]]`);
			if (node.closesRef && orgItemId) {
				bodyLines.push(`\nWARNING: This node closes org ${orgItemId}. The lifecycle obligation transfers to the FUP.`);
			}
			lines.push(`  org create category=followups title="${suggestedTitle}" body="${bodyLines.join("\n")}"`);
			lines.push("");
			lines.push("Step 2: Abandon with the FUP ID:");
			lines.push(`  todo_write tasks: [{id: "${node.id}", status: "abandoned", deferralFupId: "FUP_ID"}]`);
		}
	}

	return lines.join("\n");
}

// =============================================================================
// Direct-work gate verification
// =============================================================================

async function captureDirectWorkBaselines(
	session: ToolSession,
	params: TodoWriteParams,
	previousNodes: TodoNode[],
	nextNodes: TodoNode[],
): Promise<void> {
	const previousStatuses = buildPreviousStatusMap(previousNodes);
	// Node ids for which THIS call explicitly requested status:"in_progress".
	const explicitInProgress = new Set(
		params.tasks.filter(task => task.id && task.status === "in_progress").map(task => task.id as string),
	);
	for (const node of nextNodes) {
		if (isDelegatedNode(node)) continue;
		if (!node.verify?.commit || node.status !== "in_progress") continue;
		const enteringInProgress = previousStatuses.get(node.id) !== "in_progress";
		// RC-C repair: a node may carry a missing/failed baseline — it entered
		// in_progress before the field existed, or in a since-wiped session. An
		// explicit re-entry (status:"in_progress" submitted again) re-captures it so
		// the commit gate has a repair path instead of being permanently stuck.
		const repairMissingBaseline = explicitInProgress.has(node.id) && !node.gitBaseline;
		if (!enteringInProgress && !repairMissingBaseline) continue;
		node.gitBaseline = session.captureGitBaseline ? await session.captureGitBaseline() : null;
	}
}

async function verifyDirectWorkCompletions(
	session: ToolSession,
	params: TodoWriteParams,
	previousNodes: TodoNode[],
	nextNodes: TodoNode[],
	reviewNotices: string[] = [],
): Promise<GateVerificationFailure[]> {
	const gateVerificationFailures: GateVerificationFailure[] = [];
	const executions = [...(session.getExecutionHistory?.() ?? [])];
	const currentStatuses = buildPreviousStatusMap(previousNodes);
	const reviewGatingEnabled = session.settings.get("todo.reviewJudge") !== false;
	const reviewJudge = reviewGatingEnabled ? session.getReviewJudge?.() : undefined;

	for (const input of params.tasks) {
		if (!input.id) continue;
		const node = findNode(nextNodes, input.id);
		if (!node) continue;
		if (isDelegatedNode(node)) {
			if (input.status !== undefined) currentStatuses.set(node.id, node.status);
			continue;
		}

		if (input.status === "in_progress") {
			currentStatuses.set(node.id, "in_progress");
			continue;
		}

		if (input.status === "completed" && input.verified && hasRequiredGate(node)) {
			// One evaluator for every gate kind. The commit gate is real-HEAD-vs-baseline
			// (identical to the delegated path): pass the baseline SHA captured when the
			// node entered in_progress, and verifyGates compares the live HEAD in cwd.
			const failures = [
				...(
					await verifyGates({
						gateCmd: node.verify?.cmd,
						gateArtifact: node.verify?.artifact,
						gateCommit: node.verify?.commit,
						executions,
						cwd: session.cwd,
						baselineHeadCommit: node.gitBaseline?.head,
					})
				).failures,
			] as GateFailure[];

			if (failures.length > 0) {
				const previousStatus = currentStatuses.get(node.id);
				node.status = previousStatus ?? "pending";
				gateVerificationFailures.push({ node, previousStatus, failures });
				continue;
			}
		}

		// verify.review LLM-gating (single-phase: the judge IS the verification).
		if (input.status === "completed" && node.status === "completed" && node.verify?.review && reviewJudge) {
			const verdict = await reviewJudge({
				nodeId: node.id,
				content: node.content,
				criteria: node.verify.review,
				context: session.getCompactContext?.() ?? "",
			});
			if (verdict.degraded) {
				reviewNotices.push(`INFO: ${node.id} review not gated (${verdict.reason}).`);
			} else if (!verdict.pass) {
				const previousStatus = currentStatuses.get(node.id);
				node.status = previousStatus ?? "in_progress";
				gateVerificationFailures.push({
					node,
					previousStatus,
					failures: [{ gate: "verify.review", expected: node.verify.review, detail: verdict.reason || "Review criteria were not met." }],
				});
				continue;
			}
		}

		if (input.status !== undefined) currentStatuses.set(node.id, node.status);
	}

	return gateVerificationFailures;
}

// =============================================================================
// Graph events
// =============================================================================

function firstUnresolvedBlockerUri(node: TodoNode, allNodes: TodoNode[], context: ResolvedTodoContext): string | undefined {
	for (const blockerRef of node.blockers ?? []) {
		const blocker = resolveNodeRef(blockerRef, allNodes, context);
		if (!blocker) continue;
		if (blocker.status !== "completed" && blocker.status !== "abandoned") return blocker.uri;
	}
	return undefined;
}

function emitTodoGraphEvents(
	session: ToolSession,
	previousNodes: TodoNode[],
	nextNodes: TodoNode[],
	context: ResolvedTodoContext,
): void {
	const eventBus = session.eventBus;
	if (!eventBus) return;
	const previous = hydrateNodes(cloneTodoNodes(previousNodes), context);
	const next = hydrateNodes(cloneTodoNodes(nextNodes), context);
	const previousByUri = new Map(previous.map(node => [node.uri!, node] as const));
	for (const node of next) {
		const previousNode = previousByUri.get(node.uri!);
		if (!previousNode) {
			eventBus.emit("todo:task:created", { taskUri: node.uri!, kind: node.kind ?? "work", slug: node.id });
			eventBus.emit("todo:dag:node_added", {
				nodeUri: node.uri!,
				deps: (node.blockers ?? [])
					.map(ref => resolveNodeRef(ref, next, context)?.uri)
					.filter((uri): uri is string => uri !== undefined),
			});
			if (node.status !== "pending") {
				eventBus.emit("todo:task:status", { taskUri: node.uri!, from: "pending", to: node.status });
			}
			continue;
		}
		if (previousNode.status !== node.status) {
			eventBus.emit("todo:task:status", { taskUri: node.uri!, from: previousNode.status, to: node.status });
		}
		const wasBlocked = firstUnresolvedBlockerUri(previousNode, previous, context);
		const isBlocked = firstUnresolvedBlockerUri(node, next, context);
		if (!wasBlocked && isBlocked) eventBus.emit("todo:task:blocked", { taskUri: node.uri!, blockerUri: isBlocked });
		else if (wasBlocked && !isBlocked) eventBus.emit("todo:task:unblocked", { taskUri: node.uri! });
	}
}

// =============================================================================
// Journal projection
// =============================================================================

/** Project flat nodes into the grouped shape the journal serializer expects. */
function nodesToJournalGroups(nodes: TodoNode[]): Array<{
	id: string;
	name: string;
	tasks: Array<{
		id: string;
		content: string;
		status: TodoStatus;
		notes?: string;
		details?: string;
		verify?: TodoVerify;
		blockers?: string[];
		ref?: string | null;
		closesRef?: boolean;
		deferralFupId?: string;
	}>;
}> {
	const order: string[] = [];
	const buckets = new Map<string, TodoNode[]>();
	for (const node of nodes) {
		const label = node.group?.trim() || "Tasks";
		if (!buckets.has(label)) {
			buckets.set(label, []);
			order.push(label);
		}
		buckets.get(label)!.push(node);
	}
	return order.map((label, idx) => ({
		id: `group-${idx + 1}`,
		name: label,
		tasks: buckets.get(label)!.map(node => ({
			id: node.id,
			content: node.content,
			status: node.status,
			notes: node.notes,
			details: node.details,
			verify: node.verify,
			blockers: node.blockers,
			ref: node.ref,
			closesRef: node.closesRef,
			deferralFupId: node.deferralFupId,
		})),
	}));
}

// =============================================================================
// Tool Class
// =============================================================================

export class TodoWriteTool implements AgentTool<typeof todoWriteSchema, TodoWriteToolDetails> {
	readonly name = "todo_write";
	readonly label = "Todo Write";
	readonly description: string;
	readonly parameters = todoWriteSchema;
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
			const previousNodes = cloneTodoNodes(this.session.getTodoNodes?.() ?? []);
			const current = fileFromNodes(cloneTodoNodes(previousNodes));
			const activePolicies = this.session.getResolvedTaskPolicies?.() ?? [];
			const context = resolveTodoContext(this.session);
			const isolationMode = Boolean(this.session.settings.get("task.isolation.mode"));
			const { file: updated, errors, warnings, completedGroups, completedGatedNodes, pendingVerificationNodes, pendingDeferralNodes } =
				applyReconcile(current, params, previousNodes, activePolicies, context, isolationMode);
			await captureDirectWorkBaselines(this.session, params, previousNodes, updated.nodes);
			const reviewNotices: string[] = [];
			const gateVerificationFailures = await verifyDirectWorkCompletions(this.session, params, previousNodes, updated.nodes, reviewNotices);
			const waveSnapshotRequests = collectWaveSnapshotRequests(previousNodes, updated.nodes);
			const waveSnapshotNotices: string[] = [];
			this.session.setTodoNodes?.(updated.nodes, params.reset ? { reset: true } : undefined);
			const waveSnapshotSession = this.session as ToolSession & {
				hasWaveSnapshot?: (ref: string) => boolean;
				recordWaveSnapshot?: (ref: string) => void;
			};
			for (const request of waveSnapshotRequests) {
				if (waveSnapshotSession.hasWaveSnapshot?.(request.ref)) continue;
				const snapshot = await createWaveSnapshot(this.session.cwd ?? getProjectDir(), request.planItemId, request.waveIndex);
				if (snapshot.ref && (snapshot.created || snapshot.commit)) waveSnapshotSession.recordWaveSnapshot?.(snapshot.ref);
				if (snapshot.warning) waveSnapshotNotices.push(`WARN: ${snapshot.warning}`);
				else if (snapshot.ref && snapshot.commit) waveSnapshotNotices.push(`INFO: Created wave snapshot ${snapshot.ref} at ${snapshot.commit}.`);
			}
			const orgLifecycleNotices = await applyOrgLifecycleHooks(this.session, previousNodes, updated.nodes);
			emitTodoGraphEvents(this.session, previousNodes, updated.nodes, context);
			this.session.eventBus?.emit("todo:change", { nodes: updated.nodes });
			const storage = this.session.getSessionFile() ? "session" : "memory";

			const sessionId = this.session.getSessionId?.() ?? "default";
			const projectRoot = this.session.cwd ?? getProjectDir();
			void writeJournal(projectRoot, sessionId, nodesToJournalGroups(updated.nodes));

			const summary = formatSummary({
				nodes: updated.nodes,
				errors,
				warnings,
				completedGroups,
				completedGatedNodes,
				pendingVerificationNodes,
				gateVerificationFailures,
				pendingDeferralNodes,
			});
			const extraNotices = [...waveSnapshotNotices, ...orgLifecycleNotices, ...reviewNotices];
			const text = extraNotices.length > 0 ? `${summary}\n${extraNotices.join("\n")}` : summary;

			return {
				content: [{ type: "text", text }],
				details: { nodes: updated.nodes, storage },
				data: { nodes: updated.nodes, storage },
			};
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface TodoWriteRenderArgs {
	tasks?: Array<{ id?: string }>;
	reset?: boolean;
}

/** Render compact gate badges after node content. */
function renderGateBadges(node: TodoNode, uiTheme: Theme): string {
	const badges: string[] = [];
	const v = node.verify;
	if (v?.commit) badges.push("[commit]");
	if (v?.artifact) badges.push(`[artifact: ${v.artifact}]`);
	if (v?.cmd) badges.push("[cmd]");
	if (v?.review) badges.push("[review]");
	if (node.layer) badges.push(`[${node.layer}]`);
	if (node.closesRef && node.ref) badges.push(`[closes: ${node.ref}]`);
	else if (node.ref) badges.push(`[ref: ${node.ref}]`);
	if (badges.length === 0) return "";
	return ` ${uiTheme.fg("dim", badges.join(" "))}`;
}

function formatTodoLine(node: TodoNode, uiTheme: Theme, prefix: string, allNodes?: TodoNode[]): string {
	const checkbox = uiTheme.checkbox;
	const badges = renderGateBadges(node, uiTheme);
	const content = formatNodeContent(node);

	if (allNodes && isNodeBlocked(node, allNodes)) {
		return uiTheme.fg("warning", `${prefix}${checkbox.unchecked} ${content} [blocked]`) + badges;
	}

	switch (node.status) {
		case "completed":
			return uiTheme.fg("success", `${prefix}${checkbox.checked} ${chalk.strikethrough(content)}`) + badges;
		case "in_progress": {
			const main = uiTheme.fg("accent", `${prefix}${checkbox.unchecked} ${content}`) + badges;
			if (!node.details) return main;
			const detailLines = node.details.split("\n").map(line => uiTheme.fg("dim", `${prefix}  ${line}`));
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
		const count = args.tasks?.length ?? 0;
		const label = args.reset ? `reset ${count}` : `${count} task${count === 1 ? "" : "s"}`;
		const text = renderStatusLine({ icon: "pending", title: "Todo Write", meta: [label] }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: TodoWriteToolDetails },
		options: RenderResultOptions,
		uiTheme: Theme,
		_args?: TodoWriteRenderArgs,
	): Component {
		const nodes = (result.details?.nodes ?? []).filter(node => node.content.length > 0);
		const header = renderStatusLine({ icon: "success", title: "Todo Write", meta: [`${nodes.length} tasks`] }, uiTheme);
		if (nodes.length === 0) {
			const fallback = result.content?.find(part => part.type === "text")?.text ?? "No todos";
			return new Text(`${header}\n${uiTheme.fg("dim", fallback)}`, 0, 0);
		}

		const { expanded } = options;
		const byLabel = groupsByLabel(nodes);
		const lines: string[] = [header];
		if (byLabel.size > 1) {
			const ungrouped = nodes.filter(node => !node.group?.trim());
			const renderBucket = (label: string | undefined, bucket: TodoNode[]): void => {
				if (label) lines.push(uiTheme.fg("accent", `  ${uiTheme.tree.hook} ${label}`));
				lines.push(
					...renderTreeList(
						{
							items: bucket,
							expanded,
							maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
							itemType: "todo",
							renderItem: node => formatTodoLine(node, uiTheme, "", nodes),
						},
						uiTheme,
					),
				);
			};
			for (const [label, bucket] of byLabel) renderBucket(label, bucket);
			if (ungrouped.length > 0) renderBucket(undefined, ungrouped);
		} else {
			lines.push(
				...renderTreeList(
					{
						items: nodes,
						expanded,
						maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
						itemType: "todo",
						renderItem: node => formatTodoLine(node, uiTheme, "", nodes),
					},
					uiTheme,
				),
			);
		}
		return new Text(lines.join("\n"), 0, 0);
	},
	mergeCallAndResult: true,
};

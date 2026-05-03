import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import { $env } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { TodoGroup } from "../tools/todo-write";
import type { BatchImplicitBlocker } from "./batch-scheduler";
import type { NestedRepoPatch } from "./worktree";

/** Source of an agent definition */
export type AgentSource = "bundled" | "user" | "project";

const parseNumber = (value: string | undefined, defaultValue: number): number => {
	if (value) {
		try {
			const number = Number.parseInt(value, 10);
			if (!Number.isNaN(number) && number > 0) {
				return number;
			}
		} catch {}
	}
	return defaultValue;
};

/** Maximum output bytes per agent */
export const MAX_OUTPUT_BYTES = parseNumber($env.PI_TASK_MAX_OUTPUT_BYTES, 500_000);

/** Maximum output lines per agent */
export const MAX_OUTPUT_LINES = parseNumber($env.PI_TASK_MAX_OUTPUT_LINES, 5000);

/** EventBus channel for raw subagent events */
export const TASK_SUBAGENT_EVENT_CHANNEL = "task:subagent:event";

/** EventBus channel for aggregated subagent progress */
export const TASK_SUBAGENT_PROGRESS_CHANNEL = "task:subagent:progress";

/** Single task item for parallel execution */
export const taskItemSchema = Type.Object({
	id: Type.String({
		description: "CamelCase identifier, max 48 chars",
		maxLength: 48,
	}),
	description: Type.String({
		description: "Short one-liner for UI display only — not seen by the subagent",
	}),
	filesDeps: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Files this task may mutate. Required for scope-restricted agents; trailing slash grants directory-prefix scope.",
		}),
	),
	assignment: Type.Optional(
		Type.String({
			description:
				"Complete per-task instructions the subagent executes. When omitted and todoRef is set, auto-derived from the linked todo's content and details. Must follow the Target/Change/Edge Cases/Acceptance structure when provided explicitly.",
		}),
	),
	blockers: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Task IDs within this batch that must complete before this task starts. Enables intra-batch DAG scheduling.",
		}),
	),
	todoRef: Type.Optional(
		Type.String({
			description:
				"Todo item ID (e.g. 'task-3') to link this subagent to. Resolves verification requirements (gates, orgItemId) and injects them into the subagent context automatically.",
		}),
	),
	layer: Type.Optional(
		Type.String({
			description: "Layer for policy-based gate injection. Propagated to auto-roster todo items.",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"Model override for this single task (e.g. 'anthropic/claude-haiku-4-5' or a configured role alias 'pi/smol'). Highest priority in the resolution chain — overrides batch-level model, spell.kdl rules, and settings.",
		}),
	),
});
export type TaskItem = Static<typeof taskItemSchema>;

const createTaskSchema = (options: { isolationEnabled: boolean }) => {
	const properties = {
		agent: Type.String({ description: "Agent type for all tasks in this batch" }),
		phase: Type.Optional(
			Type.String({
				description:
					"Phase name for auto-created roster entries (e.g. 'Investigation'). When omitted, a name is derived from the batch context.",
			}),
		),
		context: Type.Optional(
			Type.String({
				description:
					"Shared background prepended to every task's assignment. Put goal, non-goals, constraints, conventions, reference paths, API contracts, and global acceptance commands here once — instead of duplicating across assignments.",
			}),
		),
		schema: Type.Optional(
			Type.Record(Type.String(), Type.Unknown(), {
				description:
					"JTD schema defining expected response structure. Use typed properties. Output format belongs here — never in context or assignment.",
			}),
		),
		model: Type.Optional(
			Type.String({
				description:
					"Default model for all tasks in this batch. Per-task `model` field overrides this. Same value space as per-task model.",
			}),
		),
		tasks: Type.Array(taskItemSchema, {
			description:
				"Tasks to execute in parallel. Each must be small-scoped (3-5 files max) and self-contained given context + assignment.",
		}),
	};

	if (options.isolationEnabled) {
		return Type.Object({
			...properties,
			isolated: Type.Optional(
				Type.Boolean({
					description:
						"Run in isolated environment; explicit opt-in. Nested tasks may be auto-coerced to isolated by heuristics when needed. Returns patches. Use when tasks edit overlapping files.",
				}),
			),
		});
	}

	return Type.Object(properties);
};

export const taskSchema = createTaskSchema({ isolationEnabled: true });
export const taskSchemaNoIsolation = createTaskSchema({ isolationEnabled: false });

export type TaskSchema = typeof taskSchema | typeof taskSchemaNoIsolation;

export type TaskParams = Static<TaskSchema>;

/** A code review finding reported by the reviewer agent */
export interface ReviewFinding {
	title: string;
	body: string;
	priority: number;
	confidence: number;
	file_path: string;
	line_start: number;
	line_end: number;
}

/** Review summary submitted by the reviewer agent */
export interface ReviewSummary {
	overall_correctness: "correct" | "incorrect";
	explanation: string;
	confidence: number;
}

/** Structured review data extracted from reviewer agent */
export interface ReviewData {
	findings: ReviewFinding[];
	summary?: ReviewSummary;
}

/** Agent definition (bundled or discovered) */
export interface AgentDefinition {
	name: string;
	description: string;
	systemPrompt: string;
	tools?: string[];
	spawns?: string[] | "*";
	model?: string[];
	thinkingLevel?: ThinkingLevel;
	output?: unknown;
	blocking?: boolean;
	/** Whether the agent should reject broad-scope delegation. */
	scopeRestricted?: boolean;
	/** Whether task dispatches using this agent auto-create todo roster entries. Default: true. */
	roster?: boolean;
	source: AgentSource;
	filePath?: string;
}

/** Auto-retry state for a subagent waiting to retry a failed provider call */
export interface AgentRetryState {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
}

/** Progress tracking for a single agent */
export type SubagentOutcome =
	| "pending"
	| "running"
	| "completed"
	| "completed-empty"
	| "failed"
	| "crashed"
	| "timeout"
	| "aborted"
	| "cancelled"
	| "policy-rejected"
	| "depth-capped"
	| "submit-result-missing"
	| "schema-invalid"
	| "gate_failed"
	| "abandoned";

export interface SpawnAuditEntry {
	requestedAgent: string;
	parentSpawnPolicy: string;
	allowedAgents: string[];
	granted: boolean;
	reason?: string;
}

export interface AgentProgress {
	index: number;
	id: string;
	agent: string;
	agentSource: AgentSource;
	status: SubagentOutcome;
	task: string;
	assignment?: string;
	description?: string;
	lastIntent?: string;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartMs?: number;
	recentTools: Array<{ tool: string; args: string; endMs: number }>;
	recentOutput: string[];
	toolCount: number;
	tokens: number;
	durationMs: number;
	retry?: AgentRetryState;
	modelOverride?: string | string[];
	sessionId?: string;
	transcriptPath?: string;
	todoGroups?: TodoGroup[];
	/** Running cost from accumulated message_end events */
	usage?: { cost: number };
	/** Data extracted by registered subprocess tool handlers (keyed by tool name) */
	extractedToolData?: Record<string, unknown[]>;
}

/** Result from a single agent execution */
export interface SingleResult {
	index: number;
	id: string;
	agent: string;
	agentSource: AgentSource;
	task: string;
	assignment?: string;
	description?: string;
	lastIntent?: string;
	exitCode: number;
	outcome: SubagentOutcome;
	stderr: string;
	resultUri: string;
	structuredResult?: unknown;
	textPreview?: string;
	children?: SingleResult[];
	durationMs: number;
	tokens: number;
	modelOverride?: string | string[];
	error?: string;
	aborted?: boolean;
	abortReason?: string;
	sessionId?: string;
	transcriptUri?: string;
	todoGroups?: TodoGroup[];
	/** Aggregated usage from the subprocess, accumulated incrementally from message_end events. */
	usage?: Usage;
	/** Output path for the task result */
	outputPath?: string;
	/** Patch path for isolated worktree output */
	patchPath?: string;
	/** Branch name for isolated branch-mode output */
	branchName?: string;
	/** Nested repo patches to apply after parent merge */
	nestedPatches?: NestedRepoPatch[];
	/** Data extracted by registered subprocess tool handlers (keyed by tool name) */
	extractedToolData?: Record<string, unknown[]>;
	/** Output metadata for agent:// URL integration */
	outputMeta?: { lineCount: number; charCount: number };
	spawnAudit?: SpawnAuditEntry;
}

/** Tool details for TUI rendering */
export interface TaskToolDetails {
	projectAgentsDir: string | null;
	results: SingleResult[];
	totalDurationMs: number;
	/** Aggregated usage across all subagents. */
	usage?: Usage;
	progress?: AgentProgress[];
	implicit_blockers?: BatchImplicitBlocker[];
	/** True when caller requested isolated execution but task.isolation.mode="none"; batch ran non-isolated. */
	isolationDowngraded?: boolean;
	/** True when isolation was auto-coerced from nested task heuristics. */
	isolationAutoCoerced?: boolean;
	async?: {
		state: SubagentOutcome;
		jobId: string;
		type: "task";
	};
}

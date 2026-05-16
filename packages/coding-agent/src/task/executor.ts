/**
 * In-process execution for subagents.
 *
 * Runs each subagent on the main thread and forwards AgentEvents for progress tracking.
 */
import path from "node:path";
import type { AgentEvent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { type SystemPromptBlock, systemPromptText } from "@oh-my-pi/pi-ai";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import type { TSchema } from "@sinclair/typebox";
import Ajv, { type ValidateFunction } from "ajv";
import { ModelRegistry } from "../config/model-registry";
import { resolveModelCandidates } from "../config/model-resolver";
import { type PromptTemplate, renderPromptTemplate } from "../config/prompt-templates";
import { Settings } from "../config/settings";
import { SETTINGS_SCHEMA, type SettingPath } from "../config/settings-schema";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { Skill } from "../extensibility/skills";
import { callTool } from "../mcp/client";
import type { MCPManager } from "../mcp/manager";
import submitReminderTemplate from "../prompts/system/subagent-submit-reminder.md" with { type: "text" };
import subagentSystemPromptTemplate from "../prompts/system/subagent-system-prompt.md" with { type: "text" };
import swarmAgentSystemPromptTemplate from "../prompts/system/swarm-agent-system-prompt.md" with { type: "text" };
import type { SandboxPolicy } from "../sandbox";
import { createAgentSession, discoverAuthStorage } from "../sdk";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import type { AuthStorage } from "../session/auth-storage";
import { SessionManager } from "../session/session-manager";
import { createHandoffTool } from "../swarm/handoff-tool";
import { createSpawnSuccessorTool } from "../swarm/spawn-successor-tool";
import type { SwarmNodeLike } from "../task/swarm-scheduler";
import { type ContextFileEntry, truncateTail } from "../tools";
import { jtdToJsonSchema } from "../tools/jtd-to-json-schema";
import { cloneTodoGroups, type TodoGroup } from "../tools/todo-write";
import { ToolAbortError } from "../tools/tool-errors";
import { EventBus, Priority } from "../utils/event-bus";
import { buildNamedToolChoice } from "../utils/tool-choice";
// Import bash subprocess handler for side effects (tracks bash commands for gate verification)
import "./bash-subprocess-handler";
import { type GateFailure, type TrackedBashExecution, verifyGates } from "./gate-verification";
import { createProgressHeartbeat } from "./progress-heartbeat";
import { subprocessToolRegistry } from "./subprocess-tool-registry";
import {
	type AgentDefinition,
	type AgentProgress,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	type ReviewFinding,
	type SingleResult,
	type SpawnAuditEntry,
	type SubagentOutcome,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "./types";

const MCP_CALL_TIMEOUT_MS = 60_000;
const ajv = new Ajv({ allErrors: true, strict: false, logger: false });

/** Agent event types to forward for progress tracking. */
const agentEventTypes = new Set<AgentEvent["type"]>([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

const isAgentEvent = (event: AgentSessionEvent): event is AgentEvent =>
	agentEventTypes.has(event.type as AgentEvent["type"]);

function normalizeModelPatterns(value: string | string[] | undefined): string[] {
	if (!value) return [];
	if (Array.isArray(value)) {
		return value.map(entry => entry.trim()).filter(Boolean);
	}
	return value
		.split(",")
		.map(entry => entry.trim())
		.filter(Boolean);
}

type StartupFallbackAttempt = {
	model: string;
	error: string;
};

function formatStartupCandidate(model: { provider: string; id: string } | undefined): string {
	return model ? `${model.provider}/${model.id}` : "default model";
}

function isStartupAuthFailureMessage(message: string): boolean {
	return /\b401\b|\b403\b|invalid bearer token|invalid[_ ]token|invalid[_ ]grant|unauthorized|forbidden|authentication(?:[_ ]error| failed|required)|oauth token/i.test(
		message,
	);
}

function isStartupProviderUnavailableMessage(message: string): boolean {
	return /provider unavailable|service unavailable|temporarily unavailable|model or endpoint not found|connection is unavailable|resource temporarily unavailable|requires authentication|no api key/i.test(
		message,
	);
}

function shouldFallbackStartupFailure(message: string): boolean {
	return isStartupAuthFailureMessage(message) || isStartupProviderUnavailableMessage(message);
}

function summarizeStartupFallbackFailures(attempts: StartupFallbackAttempt[]): string {
	const [firstAttempt] = attempts;
	if (!firstAttempt) return "Subagent startup failed";
	if (attempts.length === 1) return firstAttempt.error;
	const details = attempts.map(attempt => `- ${attempt.model}: ${attempt.error}`).join("\n");
	return `${firstAttempt.error}\nFallback attempts:\n${details}`;
}

function withAbortTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
	if (signal?.aborted) {
		return Promise.reject(new ToolAbortError());
	}

	const { promise: wrappedPromise, resolve, reject } = Promise.withResolvers<T>();
	let settled = false;
	const timeoutId = setTimeout(() => {
		if (settled) return;
		settled = true;
		reject(new Error(`MCP tool call timed out after ${timeoutMs}ms`));
	}, timeoutMs);

	const onAbort = () => {
		if (settled) return;
		settled = true;
		clearTimeout(timeoutId);
		reject(new ToolAbortError());
	};

	if (signal) {
		signal.addEventListener("abort", onAbort, { once: true });
	}

	promise.then(resolve, reject).finally(() => {
		if (signal) signal.removeEventListener("abort", onAbort);
		clearTimeout(timeoutId);
	});

	return wrappedPromise;
}

function getReportFindingKey(value: unknown): string | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const title = typeof record.title === "string" ? record.title : null;
	const filePath = typeof record.file_path === "string" ? record.file_path : null;
	const lineStart = typeof record.line_start === "number" ? record.line_start : null;
	const lineEnd = typeof record.line_end === "number" ? record.line_end : null;
	const priority = typeof record.priority === "string" ? record.priority : null;
	if (!title || !filePath || lineStart === null || lineEnd === null) {
		return null;
	}
	return `${filePath}:${lineStart}:${lineEnd}:${priority ?? ""}:${title}`;
}

export interface RuntimeVerificationOptions {
	gateCmd?: string;
	gateCommit?: boolean;
	gateArtifact?: string;
	baselineHeadCommit?: string;
}

/** Options for subagent execution */
export interface ExecutorOptions {
	cwd: string;
	worktree?: string;
	agent: AgentDefinition;
	task: string;
	assignment?: string;
	description?: string;
	index: number;
	id: string;
	modelOverride?: string | string[];
	thinkingLevel?: ThinkingLevel;
	outputSchema?: unknown;
	/** Parent task recursion depth (0 = top-level, 1 = first child, etc.) */
	taskDepth?: number;
	enableLsp?: boolean;
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;
	sessionFile?: string | null;
	persistArtifacts?: boolean;
	artifactsDir?: string;
	/** Path to parent conversation context file */
	contextFile?: string;
	eventBus?: EventBus;
	contextFiles?: ContextFileEntry[];
	skills?: Skill[];
	promptTemplates?: PromptTemplate[];
	mcpManager?: MCPManager;
	authStorage?: AuthStorage;
	modelRegistry?: ModelRegistry;
	settings?: Settings;
	sandboxPolicy?: SandboxPolicy;
	filesDeps?: string[];
	runtimeVerification?: RuntimeVerificationOptions;
	/** Additional custom tools injected by the caller (e.g., orchestrator escalate). */
	customTools?: CustomTool[];
	/** Swarm runtime context; when absent, swarm tools stay unavailable. */
	swarmContext?: {
		active: boolean;
		agent: string;
		sessionId: string;
		currentTaskUri?: string;
		blackboard?: import("../swarm/blackboard").SwarmBlackboard;
		scheduler?: import("../task/swarm-scheduler").SwarmScheduler<SwarmNodeLike>;
	};
}

function parseStringifiedJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (!trimmed) return value;
	if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return value;
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

function normalizeOutputSchema(schema: unknown): {
	normalized?: unknown;
	error?: string;
} {
	if (schema === undefined || schema === null) return {};
	if (typeof schema === "string") {
		try {
			return { normalized: JSON.parse(schema) };
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err) };
		}
	}
	return { normalized: schema };
}
// Schema grammar boundary: JTD in agent frontmatter vs TypeBox in code.
// See tasks/plans/plan-artifacts/PLAN-308/ADR-schema-grammar-boundary.md


function buildOutputValidator(schema: unknown): {
	validate?: ValidateFunction;
	error?: string;
} {
	const { normalized, error } = normalizeOutputSchema(schema);
	if (error) return { error };
	if (normalized === undefined) return {};
	const jsonSchema = jtdToJsonSchema(normalized);
	try {
		return { validate: ajv.compile(jsonSchema as any) };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

function tryParseJsonOutput(text: string): unknown | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

function extractCompletionData(parsed: unknown): unknown {
	if (!parsed || typeof parsed !== "object") return parsed;
	const record = parsed as Record<string, unknown>;
	if ("data" in record) {
		return record.data;
	}
	return parsed;
}

function normalizeCompleteData(data: unknown, reportFindings?: ReviewFinding[]): unknown {
	let normalized = parseStringifiedJson(data ?? null);
	if (
		Array.isArray(reportFindings) &&
		reportFindings.length > 0 &&
		normalized &&
		typeof normalized === "object" &&
		!Array.isArray(normalized)
	) {
		const record = normalized as Record<string, unknown>;
		if (!("findings" in record)) {
			normalized = { ...record, findings: reportFindings };
		}
	}
	return normalized;
}

function resolveFallbackCompletion(rawOutput: string, outputSchema: unknown): { data: unknown } | null {
	const parsed = tryParseJsonOutput(rawOutput);
	if (parsed === undefined) return null;
	const candidate = parseStringifiedJson(extractCompletionData(parsed));
	if (candidate === undefined) return null;
	const { validate, error } = buildOutputValidator(outputSchema);
	if (error) return null;
	if (validate && !validate(candidate)) return null;
	return { data: candidate };
}

export interface SubmitResultItem {
	data?: unknown;
	status?: "success" | "aborted";
	error?: string;
	/** True when runtime gate verification accepted this submission. Stamped by the executor at extract time. */
	gateAccepted?: boolean;
	/** Gate verification failures recorded when gateAccepted === false. */
	gateFailures?: GateFailure[];
}

interface FinalizeSubprocessOutputArgs {
	rawOutput: string;
	exitCode: number;
	stderr: string;
	doneAborted: boolean;
	signalAborted: boolean;
	submitResultItems?: SubmitResultItem[];
	reportFindings?: ReviewFinding[];
	outputSchema: unknown;
}

interface FinalizeSubprocessOutputResult {
	rawOutput: string;
	exitCode: number;
	stderr: string;
	abortedViaSubmitResult: boolean;
	hasSubmitResult: boolean;
}

function stringifyStructuredResult(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	try {
		return JSON.stringify(value, null, 2);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function buildTextPreview(value: string | undefined, maxChars = 2000): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	if (trimmed.length <= maxChars) return trimmed;
	const slice = trimmed.slice(0, maxChars);
	const lastNewline = slice.lastIndexOf("\n");
	return (lastNewline >= 0 ? slice.slice(0, lastNewline) : slice).trimEnd();
}

function parseSpawnAudit(value: string | undefined): SpawnAuditEntry | undefined {
	const text = value?.trim();
	if (!text) return undefined;
	const match = text.match(/Cannot spawn '([^']+)'\. Allowed: (.+)$/u);
	if (!match) return undefined;
	const requestedAgent = match[1]?.trim();
	const parentSpawnPolicy = match[2]?.trim() ?? "";
	const allowedAgents =
		parentSpawnPolicy === "*"
			? ["*"]
			: parentSpawnPolicy.startsWith("none")
				? []
				: parentSpawnPolicy
						.split(",")
						.map(entry => entry.trim())
						.filter(Boolean);
	if (!requestedAgent) return undefined;
	return {
		requestedAgent,
		parentSpawnPolicy,
		allowedAgents,
		granted: false,
		reason: "policy-rejected",
	};
}

function extractNestedTaskResults(value: unknown): SingleResult[] | undefined {
	if (!value || typeof value !== "object") return undefined;
	const details = value as { results?: unknown };
	if (!Array.isArray(details.results)) return undefined;
	return structuredClone(details.results as SingleResult[]);
}

export const SUBAGENT_WARNING_NULL_SUBMIT_RESULT = "SYSTEM WARNING: Subagent called submit_result with null data.";
export const SUBAGENT_WARNING_MISSING_SUBMIT_RESULT =
	"SYSTEM WARNING: Subagent exited without calling submit_result tool after 3 reminders.";
export const SUBAGENT_WARNING_MISSING_VERIFICATION_PROOF =
	"SYSTEM WARNING: Subagent called submit_result success before runtime observed required verification proof.";

function prependSubagentWarning(rawOutput: string, warning: string): string {
	return rawOutput ? `${warning}\n\n${rawOutput}` : warning;
}

function hasRuntimeVerification(opts: RuntimeVerificationOptions | undefined): boolean {
	return Boolean(opts?.gateCmd || opts?.gateCommit || opts?.gateArtifact);
}

function formatGateFailures(failures: GateFailure[]): string[] {
	return failures.map(
		failure => `- ${failure.gate} not satisfied: expected \`${failure.expected}\`; ${failure.detail}`,
	);
}

function buildMissingVerificationProofMessage(failures: GateFailure[]): string {
	const details = formatGateFailures(failures).join("\n");
	return details.length > 0
		? `${SUBAGENT_WARNING_MISSING_VERIFICATION_PROOF}\n${details}`
		: SUBAGENT_WARNING_MISSING_VERIFICATION_PROOF;
}

export function finalizeSubprocessOutput(args: FinalizeSubprocessOutputArgs): FinalizeSubprocessOutputResult {
	let { rawOutput, exitCode, stderr } = args;
	const { submitResultItems, reportFindings, doneAborted, signalAborted, outputSchema } = args;
	let abortedViaSubmitResult = false;
	const hasSubmitResult = Array.isArray(submitResultItems) && submitResultItems.length > 0;

	if (hasSubmitResult) {
		const lastSubmitResult = submitResultItems[submitResultItems.length - 1];
		if (lastSubmitResult?.status === "aborted") {
			abortedViaSubmitResult = true;
			exitCode = 0;
			stderr = lastSubmitResult.error || "Subagent aborted task";
			try {
				rawOutput = JSON.stringify({ aborted: true, error: lastSubmitResult.error }, null, 2);
			} catch {
				rawOutput = `{"aborted":true,"error":"${lastSubmitResult.error || "Unknown error"}"}`;
			}
		} else {
			const submitData = lastSubmitResult?.data;
			if (submitData === null || submitData === undefined) {
				rawOutput = prependSubagentWarning(rawOutput, SUBAGENT_WARNING_NULL_SUBMIT_RESULT);
			} else {
				const completeData = normalizeCompleteData(submitData, reportFindings);
				try {
					rawOutput = JSON.stringify(completeData, null, 2) ?? "null";
				} catch (err) {
					const errorMessage = err instanceof Error ? err.message : String(err);
					rawOutput = `{"error":"Failed to serialize submit_result data: ${errorMessage}"}`;
				}
				if (lastSubmitResult?.gateAccepted === false) {
					// BUG-354: keep structuredResult accessible (rawOutput already serialized) but mark
					// the run as gate-failed via non-zero exitCode and a clear stderr message.
					if (exitCode === 0) exitCode = 1;
					stderr = buildMissingVerificationProofMessage(lastSubmitResult.gateFailures ?? []);
				} else {
					exitCode = 0;
					stderr = "";
				}
			}
		}
	} else {
		const allowFallback = exitCode === 0 && !doneAborted && !signalAborted;
		const fallback = allowFallback ? resolveFallbackCompletion(rawOutput, outputSchema) : null;
		if (fallback) {
			const completeData = normalizeCompleteData(fallback.data, reportFindings);
			try {
				rawOutput = JSON.stringify(completeData, null, 2) ?? "null";
			} catch (err) {
				const errorMessage = err instanceof Error ? err.message : String(err);
				rawOutput = `{"error":"Failed to serialize fallback completion: ${errorMessage}"}`;
			}
			exitCode = 0;
			stderr = "";
		} else if (allowFallback) {
			rawOutput = prependSubagentWarning(rawOutput, SUBAGENT_WARNING_MISSING_SUBMIT_RESULT);
			exitCode = 0;
			stderr = "";
		}
	}

	return {
		rawOutput,
		exitCode,
		stderr,
		abortedViaSubmitResult,
		hasSubmitResult,
	};
}

/**
 * Extract a short preview from tool args for display.
 */
function extractToolArgsPreview(args: Record<string, unknown>): string {
	// Priority order for preview
	const previewKeys = ["command", "file_path", "path", "pattern", "query", "url", "task", "prompt"];

	for (const key of previewKeys) {
		if (args[key] && typeof args[key] === "string") {
			const value = args[key] as string;
			return value.length > 60 ? `${value.slice(0, 59)}…` : value;
		}
	}

	return "";
}

function getNumberField(record: Record<string, unknown>, key: string): number | undefined {
	if (!Object.hasOwn(record, key)) return undefined;
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function firstNumberField(record: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = getNumberField(record, key);
		if (value !== undefined) return value;
	}
	return undefined;
}

/**
 * Normalize usage objects from different event formats.
 */
function getUsageTokens(usage: unknown): number {
	if (!usage || typeof usage !== "object") return 0;
	const record = usage as Record<string, unknown>;

	const totalTokens = firstNumberField(record, ["totalTokens", "total_tokens"]);
	if (totalTokens !== undefined && totalTokens > 0) return totalTokens;

	const input = firstNumberField(record, ["input", "input_tokens", "inputTokens"]) ?? 0;
	const output = firstNumberField(record, ["output", "output_tokens", "outputTokens"]) ?? 0;
	const cacheRead = firstNumberField(record, ["cacheRead", "cache_read", "cacheReadTokens"]) ?? 0;
	const cacheWrite = firstNumberField(record, ["cacheWrite", "cache_write", "cacheWriteTokens"]) ?? 0;

	return input + output + cacheRead + cacheWrite;
}

/**
 * Create proxy tools that reuse the parent's MCP connections.
 */
function createMCPProxyTools(mcpManager: MCPManager): CustomTool<TSchema>[] {
	return mcpManager.getTools().map(tool => {
		const mcpTool = tool as { mcpToolName?: string; mcpServerName?: string };
		return {
			name: tool.name,
			label: tool.label ?? tool.name,
			description: tool.description ?? "",
			parameters: tool.parameters as TSchema,
			execute: async (_toolCallId, params, _onUpdate, _ctx, signal) => {
				if (signal?.aborted) {
					throw new ToolAbortError();
				}
				const serverName = mcpTool.mcpServerName ?? "";
				const mcpToolName = mcpTool.mcpToolName ?? "";
				try {
					const result = await withAbortTimeout(
						(async () => {
							const connection = await mcpManager.waitForConnection(serverName);
							return callTool(connection, mcpToolName, params as Record<string, unknown>, { signal });
						})(),
						MCP_CALL_TIMEOUT_MS,
						signal,
					);
					return {
						content: (result.content ?? []).map(item =>
							item.type === "text"
								? { type: "text" as const, text: item.text ?? "" }
								: { type: "text" as const, text: JSON.stringify(item) },
						),
						details: { serverName, mcpToolName, isError: result.isError },
					};
				} catch (error) {
					if (error instanceof ToolAbortError) {
						throw error;
					}
					return {
						content: [
							{
								type: "text" as const,
								text: `MCP error: ${error instanceof Error ? error.message : String(error)}`,
							},
						],
						details: { serverName, mcpToolName, isError: true },
					};
				}
			},
		};
	});
}

function createSubagentSettings(baseSettings: Settings): Settings {
	const snapshot: Partial<Record<SettingPath, unknown>> = {};
	for (const key of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
		snapshot[key] = baseSettings.get(key);
	}
	return Settings.isolated({
		...snapshot,
		"async.enabled": false,
		"compaction.enabled": false,
		"compaction.strategy": "off",
		"contextPromotion.enabled": false,
	});
}

function normalizeScopedPath(targetPath: string, cwd: string): { resolved: string; directory: boolean } {
	const directory = targetPath.endsWith("/") || targetPath.endsWith(path.sep);
	const trimmed = directory ? targetPath.slice(0, -1) : targetPath;
	return {
		resolved: path.resolve(cwd, trimmed),
		directory,
	};
}

function formatScopedPath(entry: { resolved: string; directory: boolean }): string {
	return entry.directory ? `${entry.resolved}${path.sep}` : entry.resolved;
}

function intersectScopedPaths(basePaths: string[], scopePaths: string[], cwd: string): string[] {
	if (basePaths.length === 0 || scopePaths.length === 0) return [];
	const results = new Set<string>();
	const normalizedBase = basePaths.map(entry => normalizeScopedPath(entry, cwd));
	const normalizedScope = scopePaths.map(entry => normalizeScopedPath(entry, cwd));
	for (const scopeEntry of normalizedScope) {
		for (const baseEntry of normalizedBase) {
			if (scopeEntry.resolved === baseEntry.resolved) {
				results.add(formatScopedPath(scopeEntry.directory && !baseEntry.directory ? baseEntry : scopeEntry));
				continue;
			}
			const basePrefix = `${baseEntry.resolved}${path.sep}`;
			const scopePrefix = `${scopeEntry.resolved}${path.sep}`;
			if (baseEntry.directory && scopeEntry.resolved.startsWith(basePrefix)) {
				results.add(formatScopedPath(scopeEntry));
				continue;
			}
			if (scopeEntry.directory && baseEntry.resolved.startsWith(scopePrefix)) {
				results.add(formatScopedPath(baseEntry));
			}
		}
	}
	return [...results];
}

export function buildScopeRestrictedSandboxPolicy(options: {
	basePolicy?: SandboxPolicy;
	parentCwd: string;
	sessionCwd: string;
	filesDeps?: string[];
}): SandboxPolicy | undefined {
	const scopePaths = (options.filesDeps ?? []).map(entry => {
		const normalized = normalizeScopedPath(entry, options.parentCwd);
		const relative = path.relative(options.parentCwd, normalized.resolved);
		const rebased = path.resolve(options.sessionCwd, relative);
		return formatScopedPath({
			resolved: rebased,
			directory: normalized.directory,
		});
	});
	if (scopePaths.length === 0) return options.basePolicy;
	if (!options.basePolicy) {
		return {
			pathsWrite: scopePaths,
			bashAllow: [],
			bashDeny: [],
			writeErrorPrefix: "OUT_OF_SCOPE_MUTATION: ",
		};
	}
	return {
		pathsWrite:
			options.basePolicy.pathsWrite.length === 0
				? []
				: intersectScopedPaths(options.basePolicy.pathsWrite, scopePaths, options.sessionCwd),
		bashAllow: [...options.basePolicy.bashAllow],
		bashDeny: [...options.basePolicy.bashDeny],
		writeErrorPrefix: "OUT_OF_SCOPE_MUTATION: ",
	};
}

/**
 * Run a single agent in-process.
 */
export async function runSubprocess(options: ExecutorOptions): Promise<SingleResult> {
	const {
		cwd,
		agent,
		task,
		assignment,
		index,
		id,
		worktree,
		modelOverride,
		thinkingLevel,
		outputSchema,
		enableLsp,
		signal,
		onProgress,
	} = options;
	const startTime = Date.now();
	const sessionCwd = worktree ?? cwd;
	const effectiveSandboxPolicy = agent.scopeRestricted
		? buildScopeRestrictedSandboxPolicy({
				basePolicy: options.sandboxPolicy,
				parentCwd: cwd,
				sessionCwd,
				filesDeps: options.filesDeps,
			})
		: options.sandboxPolicy;

	// Initialize progress
	const progress: AgentProgress = {
		index,
		id,
		agent: agent.name,
		agentSource: agent.source,
		status: "running",
		task,
		assignment,
		description: options.description,
		lastIntent: undefined,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
		modelOverride,
	};

	// Check if already aborted
	if (signal?.aborted) {
		return {
			index,
			id,
			agent: agent.name,
			agentSource: agent.source,
			task,
			assignment,
			description: options.description,
			exitCode: 1,
			outcome: "aborted",
			stderr: "Cancelled before start",
			resultUri: `agent://${id}`,
			textPreview: "Cancelled before start",
			durationMs: 0,
			tokens: 0,
			modelOverride,
			error: "Cancelled before start",
			aborted: true,
			abortReason: "Cancelled before start",
		};
	}

	// Set up artifact paths and write input file upfront if artifacts dir provided
	let subtaskSessionFile: string | undefined;
	if (options.artifactsDir) {
		subtaskSessionFile = path.join(options.artifactsDir, `${id}.jsonl`);
	}

	const settings = options.settings ?? Settings.isolated();
	const subagentSettings = createSubagentSettings(settings);
	const maxRecursionDepth = settings.get("task.maxRecursionDepth") ?? 3;
	const maxToolCalls = settings.get("task.maxToolCalls") ?? 200;
	const parentDepth = options.taskDepth ?? 0;
	const childDepth = parentDepth + 1;
	const atMaxDepth = maxRecursionDepth >= 0 && childDepth >= maxRecursionDepth;
	logger.debug("Subagent spawn", {
		agent: agent.name,
		childDepth,
		maxRecursionDepth,
		atMaxDepth,
	});

	// Add tools if specified
	let toolNames: string[] | undefined;
	if (agent.tools && agent.tools.length > 0) {
		toolNames = agent.tools;
		// Auto-include task tool if spawns defined but task not in tools
		if (agent.spawns !== undefined && !toolNames.includes("task") && !atMaxDepth) {
			toolNames = [...toolNames, "task"];
		}
	}

	if (atMaxDepth && toolNames?.includes("task")) {
		toolNames = toolNames.filter(name => name !== "task");
	}
	if (toolNames?.includes("exec")) {
		const expanded = toolNames.filter(name => name !== "exec");
		expanded.push("bash");
		toolNames = Array.from(new Set(expanded));
	}

	const modelPatterns = normalizeModelPatterns(modelOverride ?? agent.model);
	const sessionFile = subtaskSessionFile ?? null;
	const spawnsEnv = atMaxDepth
		? ""
		: agent.spawns === undefined
			? ""
			: agent.spawns === "*"
				? "*"
				: agent.spawns.join(",");

	const lspEnabled = enableLsp ?? true;

	const outputChunks: string[] = [];
	const finalOutputChunks: string[] = [];
	const RECENT_OUTPUT_TAIL_BYTES = 8 * 1024;
	let recentOutputTail = "";
	let nestedTaskResults: SingleResult[] = [];
	let stderr = "";
	let resolved = false;
	type AbortReason = "signal" | "terminate";
	let abortSent = false;
	let abortReason: AbortReason | undefined;
	const listenerController = new AbortController();
	const listenerSignal = listenerController.signal;
	const abortController = new AbortController();
	const abortSignal = abortController.signal;
	let activeSession: AgentSession | null = null;
	let unsubscribe: (() => void) | null = null;
	let submitResultCalled = false;
	// BUG-356: latched on submit_result success → blocks the agent loop from issuing further
	// reminder/retry prompts even when async event ordering races the abort signal.
	let terminating = false;
	let pendingEventProcessing = Promise.resolve();
	let missingVerificationFailures: GateFailure[] | undefined;

	// Accumulate usage incrementally from message_end events (no memory for streaming events)
	const accumulatedUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	let hasUsage = false;

	const requestAbort = (reason: AbortReason) => {
		if (abortSent) {
			if (reason === "signal" && abortReason !== "signal") {
				abortReason = "signal";
			}
			return;
		}
		if (resolved) return;
		abortSent = true;
		abortReason = reason;
		abortController.abort();
		if (activeSession) {
			void activeSession.abort();
		}
	};

	// Handle abort signal
	const onAbort = () => {
		if (!resolved) requestAbort("signal");
	};
	if (signal) {
		signal.addEventListener("abort", onAbort, {
			once: true,
			signal: listenerSignal,
		});
	}

	const resolveSignalAbortReason = (): string => {
		const reason = signal?.reason;
		if (reason instanceof Error) {
			const message = reason.message.trim();
			if (message.length > 0) return message;
		} else if (typeof reason === "string") {
			const message = reason.trim();
			if (message.length > 0) return message;
		}
		return "Cancelled by caller";
	};
	const PROGRESS_COALESCE_MS = 150;
	let lastProgressEmitMs = 0;
	let progressTimeoutId: NodeJS.Timeout | null = null;

	const emitProgressNow = () => {
		progress.durationMs = Date.now() - startTime;
		onProgress?.({ ...progress });
		if (options.eventBus) {
			options.eventBus.enqueue(
				TASK_SUBAGENT_PROGRESS_CHANNEL,
				{
					index,
					agent: agent.name,
					agentSource: agent.source,
					task,
					assignment,
					progress: { ...progress },
				},
				Priority.P2,
				`task-progress-${index}`,
			);
		}
		lastProgressEmitMs = Date.now();
	};

	const scheduleProgress = (flush = false) => {
		if (flush) {
			if (progressTimeoutId) {
				clearTimeout(progressTimeoutId);
				progressTimeoutId = null;
			}
			emitProgressNow();
			return;
		}
		const now = Date.now();
		const elapsed = now - lastProgressEmitMs;
		if (lastProgressEmitMs === 0 || elapsed >= PROGRESS_COALESCE_MS) {
			if (progressTimeoutId) {
				clearTimeout(progressTimeoutId);
				progressTimeoutId = null;
			}
			emitProgressNow();
			return;
		}
		if (progressTimeoutId) return;
		progressTimeoutId = setTimeout(() => {
			progressTimeoutId = null;
			emitProgressNow();
		}, PROGRESS_COALESCE_MS - elapsed);
	};

	// Heartbeat: keep parent progress alive when the subagent is silent (long
	// tool call, idle wait). Routed through `scheduleProgress(false)` so the
	// existing 150ms coalescer still gates real emissions — heartbeats never
	// flood the parent or stack on top of genuine events.
	const PROGRESS_HEARTBEAT_MS = 500;
	const heartbeat = createProgressHeartbeat({
		intervalMs: PROGRESS_HEARTBEAT_MS,
		isActive: () => !resolved,
		tick: () => scheduleProgress(false),
	});

	const getMessageContent = (message: unknown): unknown => {
		if (message && typeof message === "object" && "content" in message) {
			return (message as { content?: unknown }).content;
		}
		return undefined;
	};

	const getMessageUsage = (message: unknown): unknown => {
		if (message && typeof message === "object" && "usage" in message) {
			return (message as { usage?: unknown }).usage;
		}
		return undefined;
	};

	const updateRecentOutputLines = () => {
		const lines = recentOutputTail.split("\n").filter(line => line.trim());
		progress.recentOutput = lines.slice(-8).reverse();
	};

	const appendRecentOutputTail = (text: string) => {
		if (!text) return;
		recentOutputTail += text;
		if (recentOutputTail.length > RECENT_OUTPUT_TAIL_BYTES) {
			recentOutputTail = recentOutputTail.slice(-RECENT_OUTPUT_TAIL_BYTES);
		}
		updateRecentOutputLines();
	};

	const replaceRecentOutputFromContent = (content: unknown[]) => {
		recentOutputTail = "";
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const record = block as { type?: unknown; text?: unknown };
			if (record.type !== "text" || typeof record.text !== "string") continue;
			if (!record.text) continue;
			recentOutputTail += record.text;
			if (recentOutputTail.length > RECENT_OUTPUT_TAIL_BYTES) {
				recentOutputTail = recentOutputTail.slice(-RECENT_OUTPUT_TAIL_BYTES);
			}
		}
		updateRecentOutputLines();
	};

	const resetRecentOutput = () => {
		recentOutputTail = "";
		progress.recentOutput = [];
	};

	const processEvent = async (event: AgentEvent) => {
		if (resolved) return;

		if (options.eventBus) {
			options.eventBus.enqueue(
				TASK_SUBAGENT_EVENT_CHANNEL,
				{
					index,
					agent: agent.name,
					agentSource: agent.source,
					task,
					assignment,
					event,
				},
				Priority.P1,
			);
		}

		const now = Date.now();
		let flushProgress = false;

		switch (event.type) {
			case "message_start":
				if (event.message?.role === "assistant") {
					resetRecentOutput();
				}
				break;

			case "tool_execution_start": {
				progress.toolCount++;
				progress.currentTool = event.toolName;
				progress.currentToolArgs = extractToolArgsPreview(
					(event as { toolArgs?: Record<string, unknown> }).toolArgs || event.args || {},
				);
				progress.currentToolStartMs = now;
				const intent = event.intent?.trim();
				if (intent) {
					progress.lastIntent = intent;
				}
				break;
			}

			case "tool_execution_end": {
				if (progress.currentTool) {
					progress.recentTools.unshift({
						tool: progress.currentTool,
						args: progress.currentToolArgs || "",
						endMs: now,
					});
					// Keep only last 5
					if (progress.recentTools.length > 5) {
						progress.recentTools.pop();
					}
				}
				progress.currentTool = undefined;
				progress.currentToolArgs = undefined;
				progress.currentToolStartMs = undefined;

				// Check for registered subagent tool handler
				const handler = subprocessToolRegistry.getHandler(event.toolName);
				const eventArgs = (event as { args?: Record<string, unknown> }).args ?? {};
				let shouldTerminate = false;
				if (handler) {
					let extractedData: unknown;
					let acceptExtractedData = true;
					let acceptSubmitResult = false;
					if (handler.extractData) {
						extractedData = handler.extractData({
							toolName: event.toolName,
							toolCallId: event.toolCallId,
							args: eventArgs,
							result: event.result,
							isError: event.isError,
						});
						if (event.toolName === "submit_result" && extractedData !== undefined && !event.isError) {
							const submitResult = extractedData as SubmitResultItem;
							if (submitResult.status === "success" && hasRuntimeVerification(options.runtimeVerification)) {
								const executions =
									(progress.extractedToolData?.bash as TrackedBashExecution[] | undefined) ?? [];
								const gateResult = await verifyGates({
									gateCmd: options.runtimeVerification?.gateCmd,
									gateCommit: options.runtimeVerification?.gateCommit,
									gateArtifact: options.runtimeVerification?.gateArtifact,
									executions,
									cwd,
									worktreeDir: worktree,
									baselineHeadCommit: options.runtimeVerification?.baselineHeadCommit,
								});
								if (!gateResult.passed) {
									acceptExtractedData = false;
									missingVerificationFailures = gateResult.failures;
								} else {
									missingVerificationFailures = undefined;
									acceptSubmitResult = true;
								}
							} else {
								missingVerificationFailures = undefined;
								acceptSubmitResult = submitResult.status === "success" || submitResult.status === "aborted";
							}
						}
						if (extractedData !== undefined) {
							if (event.toolName === "submit_result") {
								// BUG-354: always record submit_result entries; stamp the runtime gate verdict
								// so finalization can distinguish gate-failed from a successful submission.
								const submitItem = extractedData as SubmitResultItem;
								submitItem.gateAccepted = acceptSubmitResult;
								if (!acceptSubmitResult && missingVerificationFailures) {
									submitItem.gateFailures = missingVerificationFailures;
								}
								progress.extractedToolData = progress.extractedToolData || {};
								const existing = progress.extractedToolData.submit_result || [];
								existing.push(submitItem);
								progress.extractedToolData.submit_result = existing;
								submitResultCalled = acceptSubmitResult;
							} else if (acceptExtractedData) {
								progress.extractedToolData = progress.extractedToolData || {};
								const existing = progress.extractedToolData[event.toolName] || [];
								const findingKey =
									event.toolName === "report_finding" ? getReportFindingKey(extractedData) : null;
								if (findingKey) {
									const existingIndex = existing.findIndex(item => getReportFindingKey(item) === findingKey);
									if (existingIndex >= 0) {
										existing[existingIndex] = extractedData;
									} else {
										existing.push(extractedData);
									}
								} else {
									existing.push(extractedData);
								}
								progress.extractedToolData[event.toolName] = existing;
							}
						}
					}

					shouldTerminate = Boolean(
						handler.shouldTerminate?.({
							toolName: event.toolName,
							toolCallId: event.toolCallId,
							args: eventArgs,
							result: event.result,
							isError: event.isError,
						}),
					);
					if (event.toolName === "submit_result" && !submitResultCalled) {
						shouldTerminate = false;
					}
					if (shouldTerminate) {
						terminating = true;
						requestAbort("terminate");
					}
				}
				if (event.toolName === "todo_write") {
					const todoResult = event.result as { details?: { groups?: unknown; phases?: unknown } } | undefined;
					const todoGroups = todoResult?.details?.groups ?? todoResult?.details?.phases;
					if (Array.isArray(todoGroups)) {
						progress.todoGroups = cloneTodoGroups(todoGroups as TodoGroup[]);
					}
				}
				if (event.toolName === "task") {
					const taskResults = extractNestedTaskResults(event.result?.details);
					if (taskResults) {
						nestedTaskResults = nestedTaskResults.concat(taskResults);
					}
				}
				flushProgress = true;
				// Enforce tool call budget
				if (maxToolCalls > 0 && !submitResultCalled && progress.toolCount > maxToolCalls) {
					logger.warn("Subagent exceeded tool call budget", {
						toolCount: progress.toolCount,
						maxToolCalls,
						agentId: id,
					});
					requestAbort("terminate");
				}
				break;
			}

			case "message_update": {
				if (event.message?.role !== "assistant") break;
				const assistantEvent = (
					event as AgentEvent & {
						assistantMessageEvent?: { type?: string; delta?: string };
					}
				).assistantMessageEvent;
				if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
					appendRecentOutputTail(assistantEvent.delta);
					break;
				}
				if (assistantEvent && assistantEvent.type !== "text_delta") {
					break;
				}
				const updateContent =
					getMessageContent(event.message) || (event as AgentEvent & { content?: unknown }).content;
				if (updateContent && Array.isArray(updateContent)) {
					replaceRecentOutputFromContent(updateContent);
				}
				break;
			}

			case "message_end": {
				// Extract text from assistant and toolResult messages (not user prompts)
				const role = event.message?.role;
				if (role === "assistant") {
					const messageContent =
						getMessageContent(event.message) || (event as AgentEvent & { content?: unknown }).content;
					if (messageContent && Array.isArray(messageContent)) {
						for (const block of messageContent) {
							if (block.type === "text" && block.text) {
								outputChunks.push(block.text);
							}
						}
					}
				}
				// Extract and accumulate usage (prefer message.usage, fallback to event.usage)
				const messageUsage = getMessageUsage(event.message) || (event as AgentEvent & { usage?: unknown }).usage;
				if (messageUsage && typeof messageUsage === "object") {
					// Only count assistant messages (not tool results, etc.)
					if (role === "assistant") {
						const usageRecord = messageUsage as Record<string, unknown>;
						const costRecord = (messageUsage as { cost?: Record<string, unknown> }).cost;
						hasUsage = true;
						accumulatedUsage.input += getNumberField(usageRecord, "input") ?? 0;
						accumulatedUsage.output += getNumberField(usageRecord, "output") ?? 0;
						accumulatedUsage.cacheRead += getNumberField(usageRecord, "cacheRead") ?? 0;
						accumulatedUsage.cacheWrite += getNumberField(usageRecord, "cacheWrite") ?? 0;
						accumulatedUsage.totalTokens += getNumberField(usageRecord, "totalTokens") ?? 0;
						if (costRecord) {
							accumulatedUsage.cost.input += getNumberField(costRecord, "input") ?? 0;
							accumulatedUsage.cost.output += getNumberField(costRecord, "output") ?? 0;
							accumulatedUsage.cost.cacheRead += getNumberField(costRecord, "cacheRead") ?? 0;
							accumulatedUsage.cost.cacheWrite += getNumberField(costRecord, "cacheWrite") ?? 0;
							accumulatedUsage.cost.total += getNumberField(costRecord, "total") ?? 0;
						}
					}
					// Accumulate tokens and cost for progress display
					progress.tokens += getUsageTokens(messageUsage);
					if (accumulatedUsage.cost.total > 0) {
						progress.usage = { cost: accumulatedUsage.cost.total };
					}
				}
				break;
			}

			case "agent_end":
				// Extract final content from assistant messages only (not user prompts)
				if (event.messages && Array.isArray(event.messages)) {
					for (const msg of event.messages) {
						if ((msg as { role?: string })?.role !== "assistant") continue;
						const messageContent = getMessageContent(msg);
						if (messageContent && Array.isArray(messageContent)) {
							for (const block of messageContent) {
								if (block.type === "text" && block.text) {
									finalOutputChunks.push(block.text);
								}
							}
						}
					}
				}
				flushProgress = true;
				break;
		}

		scheduleProgress(flushProgress);
	};

	const processSessionEvent = (event: AgentSessionEvent) => {
		if (resolved) return;
		if (event.type === "auto_retry_start") {
			progress.retry = {
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
			};
			scheduleProgress(true);
			return;
		}
		if (event.type === "auto_retry_end") {
			progress.retry = undefined;
			scheduleProgress(true);
		}
	};

	const runSubagent = async (): Promise<{
		exitCode: number;
		error?: string;
		aborted?: boolean;
		abortReason?: string;
		durationMs: number;
	}> => {
		let sessionAbortController = new AbortController();
		let exitCode = 0;
		let error: string | undefined;
		let aborted = false;
		let abortReasonText: string | undefined;
		const checkAbort = () => {
			if (abortSignal.aborted) {
				aborted = abortReason === "signal" || abortReason === undefined;
				if (aborted) {
					abortReasonText ??= resolveSignalAbortReason();
				}
				exitCode = 1;
				throw new ToolAbortError();
			}
		};
		const resetStartupOutput = () => {
			outputChunks.length = 0;
			finalOutputChunks.length = 0;
			recentOutputTail = "";
			progress.recentOutput = [];
		};
		const closeActiveSession = async () => {
			sessionAbortController.abort();
			sessionAbortController = new AbortController();
			if (unsubscribe) {
				try {
					unsubscribe();
				} catch {
					// Ignore unsubscribe errors
				}
				unsubscribe = null;
			}
			if (activeSession) {
				const session = activeSession;
				activeSession = null;
				try {
					await untilAborted(AbortSignal.timeout(5000), () => session.dispose());
				} catch {
					// Ignore cleanup errors
				}
			}
		};

		try {
			checkAbort();
			const authStorage = options.authStorage ?? (await discoverAuthStorage());
			checkAbort();
			const modelRegistry = options.modelRegistry ?? new ModelRegistry(authStorage);
			await modelRegistry.refresh();
			checkAbort();

			const resolvedCandidates = resolveModelCandidates(modelPatterns, modelRegistry, settings);
			const startupCandidates: Array<{
				model: (typeof resolvedCandidates)[number]["model"] | undefined;
				thinkingLevel?: ThinkingLevel;
				explicitThinkingLevel: boolean;
				pattern: string;
			}> =
				resolvedCandidates.length > 0
					? resolvedCandidates
					: [
							{
								model: undefined,
								thinkingLevel: undefined,
								explicitThinkingLevel: false,
								pattern: "",
							},
						];
			const mcpProxyTools = options.mcpManager ? createMCPProxyTools(options.mcpManager) : [];
			const swarmTools =
				options.swarmContext?.active && options.swarmContext.blackboard && options.swarmContext.scheduler
					? ([
							createHandoffTool({
								active: true,
								agent: options.swarmContext.agent,
								sessionId: options.swarmContext.sessionId,
								currentTaskUri: options.swarmContext.currentTaskUri,
								blackboard: options.swarmContext.blackboard,
								eventBus: options.eventBus ?? new EventBus(),
							}),
							createSpawnSuccessorTool({
								active: true,
								agent: options.swarmContext.agent,
								sessionId: options.swarmContext.sessionId,
								currentTaskUri: options.swarmContext.currentTaskUri ?? "",
								scheduler: options.swarmContext.scheduler,
							}),
						] as CustomTool[])
					: [];
			const allCustomTools = [...mcpProxyTools, ...swarmTools, ...(options.customTools ?? [])];
			const enableMCP = !options.mcpManager;
			const { normalized: normalizedOutputSchema } = normalizeOutputSchema(outputSchema);
			let todoWriteAvailable =
				subagentSettings.get("todo.enabled") && (toolNames === undefined || toolNames.includes("todo_write"));
			const MAX_SUBMIT_RESULT_RETRIES = 3;
			const fallbackAttempts: StartupFallbackAttempt[] = [];

			candidateLoop: for (let candidateIndex = 0; candidateIndex < startupCandidates.length; candidateIndex++) {
				const candidate = startupCandidates[candidateIndex]!;
				const candidateModel = candidate.model;
				const candidateLabel = formatStartupCandidate(candidateModel);
				const effectiveThinkingLevel = candidate.explicitThinkingLevel
					? candidate.thinkingLevel
					: (thinkingLevel ?? candidate.thinkingLevel);
				let allowRepairRetry = true;

				while (true) {
					checkAbort();
					progress.modelOverride = candidateLabel;
					const sessionManager = sessionFile
						? await SessionManager.open(sessionFile)
						: SessionManager.inMemory(worktree ?? cwd);
					let startupErrorMessage: string | undefined;
					try {
						const { session } = await createAgentSession({
							cwd: sessionCwd,
							authStorage,
							modelRegistry,
							settings: subagentSettings,
							model: candidateModel,
							thinkingLevel: effectiveThinkingLevel,
							toolNames,
							outputSchema,
							requireSubmitResultTool: true,
							contextFiles: options.contextFiles,
							skills: options.skills,
							promptTemplates: options.promptTemplates,
							systemPrompt: (defaultBlocks: SystemPromptBlock[]) => {
								const overlayParts: string[] = [];
								const subagentOverlay = renderPromptTemplate(subagentSystemPromptTemplate, {
									agent: agent.systemPrompt ?? "",
									worktree: worktree ?? "",
									outputSchema: normalizedOutputSchema,
									contextFile: options.contextFile,
									todoWriteAvailable,
								});
								overlayParts.push(subagentOverlay);
								if (
									options.swarmContext?.active &&
									options.swarmContext.blackboard &&
									options.swarmContext.scheduler
								) {
									const swarmOverlay = renderPromptTemplate(swarmAgentSystemPromptTemplate, {
										swarmEnabled: true,
										handoffEnabled: true,
										spawnSuccessorEnabled: true,
										currentTaskUri: options.swarmContext.currentTaskUri ?? "",
									});
									overlayParts.push(swarmOverlay);
								}
								const stableBlocks = defaultBlocks.filter(block => block.stable !== false);
								const dynamicTexts = defaultBlocks
									.filter(block => block.stable === false)
									.map(block => block.text);
								dynamicTexts.push(...overlayParts);

								const result: SystemPromptBlock[] = [...stableBlocks];
								if (dynamicTexts.length > 0) {
									result.push({ text: dynamicTexts.join("\n"), stable: false });
								}
								return result;
							},
							sessionManager,
							hasUI: false,
							spawns: spawnsEnv,
							taskDepth: childDepth,
							parentTaskPrefix: id,
							enableLsp: lspEnabled,
							sandboxPolicy: effectiveSandboxPolicy,

							enableMCP,
							customTools: allCustomTools.length > 0 ? allCustomTools : undefined,
						});

						activeSession = session;
						progress.sessionId = session.sessionId;
						progress.transcriptPath = sessionFile ?? undefined;
						const actualTodoWrite = session.getActiveToolNames().includes("todo_write");
						if (actualTodoWrite !== todoWriteAvailable) {
							todoWriteAvailable = actualTodoWrite;
							if (typeof session.refreshBaseSystemPrompt === "function") {
								await session.refreshBaseSystemPrompt();
							}
						}

						session.sessionManager.appendSessionInit({
							systemPrompt: systemPromptText(session.agent.state.systemPrompt) ?? "",
							task,
							tools: session.getActiveToolNames(),
							outputSchema,
						});

						abortSignal.addEventListener(
							"abort",
							() => {
								void session.abort();
							},
							{ once: true, signal: sessionAbortController.signal },
						);

						const extensionRunner = session.extensionRunner;
						if (extensionRunner) {
							extensionRunner.initialize(
								{
									sendMessage: (message, options) => {
										session.sendCustomMessage(message, options).catch(e => {
											logger.error("Extension sendMessage failed", {
												error: e instanceof Error ? e.message : String(e),
											});
										});
									},
									sendUserMessage: (content, options) => {
										session.sendUserMessage(content, options).catch(e => {
											logger.error("Extension sendUserMessage failed", {
												error: e instanceof Error ? e.message : String(e),
											});
										});
									},
									appendEntry: (customType, data) => {
										session.sessionManager.appendCustomEntry(customType, data);
									},
									setLabel: (targetId, label) => {
										session.sessionManager.appendLabelChange(targetId, label);
									},
									getActiveTools: () => session.getActiveToolNames(),
									getAllTools: () => session.getAllToolNames(),
									setActiveTools: (toolNames: string[]) => session.setActiveToolsByName(toolNames),
									getCommands: () => [],
									setModel: async model => {
										const key = await session.modelRegistry.getApiKey(model);
										if (!key) return false;
										await session.setModel(model);
										return true;
									},
									getThinkingLevel: () => session.thinkingLevel,
									setThinkingLevel: level => session.setThinkingLevel(level),
								},
								{
									getModel: () => session.model,
									isIdle: () => !session.isStreaming,
									abort: () => session.abort(),
									hasPendingMessages: () => session.queuedMessageCount > 0,
									shutdown: () => {},
									getContextUsage: () => session.getContextUsage(),
									getSystemPrompt: () => session.systemPrompt,
									getFirstUserMessage: () => session.getFirstUserMessage(),
									refreshBaseSystemPrompt: async () => {
										await session.refreshBaseSystemPrompt();
									},
									compact: async instructionsOrOptions => {
										const instructions =
											typeof instructionsOrOptions === "string" ? instructionsOrOptions : undefined;
										const options =
											instructionsOrOptions && typeof instructionsOrOptions === "object"
												? instructionsOrOptions
												: undefined;
										await session.compact(instructions, options);
									},
								},
							);
							extensionRunner.onError(err => {
								logger.error("Extension error", {
									path: err.extensionPath,
									error: err.error,
								});
							});
							await extensionRunner.emit({ type: "session_start" });
						}

						unsubscribe = session.subscribe(event => {
							pendingEventProcessing = pendingEventProcessing
								.then(async () => {
									if (isAgentEvent(event)) {
										await processEvent(event);
										return;
									}
									processSessionEvent(event);
								})
								.catch(err => {
									logger.error("Subagent event processing failed", {
										error: err instanceof Error ? err.message : String(err),
									});
									requestAbort("terminate");
								});
						});

						await session.prompt(task, { attribution: "agent" });
						await session.waitForIdle();
						await pendingEventProcessing;
						const startupAssistant = session.getLastAssistantMessage();
						if (!submitResultCalled && progress.toolCount === 0 && startupAssistant?.stopReason === "error") {
							startupErrorMessage = startupAssistant.errorMessage || "Subagent failed";
						}
					} catch (err) {
						startupErrorMessage = err instanceof Error ? err.stack || err.message : String(err);
					}

					if (!startupErrorMessage) {
						break;
					}

					if (
						!submitResultCalled &&
						progress.toolCount === 0 &&
						shouldFallbackStartupFailure(startupErrorMessage)
					) {
						fallbackAttempts.push({
							model: candidateLabel,
							error: startupErrorMessage,
						});
						const repaired =
							isStartupAuthFailureMessage(startupErrorMessage) &&
							typeof authStorage.markAuthFailure === "function"
								? await authStorage.markAuthFailure(
										candidateModel?.provider ?? "",
										progress.sessionId,
										startupErrorMessage,
										{
											baseUrl: candidateModel?.baseUrl,
											modelId: candidateModel?.id,
										},
									)
								: false;
						await closeActiveSession();
						resetStartupOutput();
						if (repaired && allowRepairRetry) {
							allowRepairRetry = false;
							continue;
						}
						if (candidateIndex < startupCandidates.length - 1) {
							continue candidateLoop;
						}
						error = summarizeStartupFallbackFailures(fallbackAttempts);
						exitCode = 1;
						break candidateLoop;
					}

					error =
						fallbackAttempts.length > 0
							? summarizeStartupFallbackFailures([
									...fallbackAttempts,
									{ model: candidateLabel, error: startupErrorMessage },
								])
							: startupErrorMessage;
					exitCode = 1;
					break candidateLoop;
				}

				if (error) {
					break;
				}

				const session = activeSession;
				if (!session) {
					error = "Subagent failed to initialize";
					exitCode = 1;
					break;
				}

				const reminderToolChoice = buildNamedToolChoice("submit_result", session.model);
				if (
					!terminating &&
					!submitResultCalled &&
					missingVerificationFailures &&
					(!abortSignal.aborted || abortReason === "terminate")
				) {
					try {
						const reminder = renderPromptTemplate(submitReminderTemplate, {
							retryCount: 1,
							maxRetries: 1,
							isLastRetry: true,
							missingVerificationProof: true,
							verificationFailures: formatGateFailures(missingVerificationFailures),
						});
						await session.prompt(reminder, { attribution: "agent" });
						await session.waitForIdle();
						await pendingEventProcessing;
					} catch (err) {
						logger.error("Subagent prompt failed", {
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}
				let retryCount = 0;
				while (
					!terminating &&
					!submitResultCalled &&
					!missingVerificationFailures &&
					retryCount < MAX_SUBMIT_RESULT_RETRIES &&
					(!abortSignal.aborted || abortReason === "terminate")
				) {
					try {
						retryCount++;
						const isLastRetry = retryCount === MAX_SUBMIT_RESULT_RETRIES;
						const reminder = renderPromptTemplate(submitReminderTemplate, {
							retryCount,
							maxRetries: MAX_SUBMIT_RESULT_RETRIES,
							isLastRetry,
							missingVerificationProof: false,
							verificationFailures: [],
						});

						// Give models that reject forced tool choice one last plain-text recovery attempt.
						const shouldForceSubmitResultToolChoice = !isLastRetry;
						await session.prompt(reminder, {
							attribution: "agent",
							...(shouldForceSubmitResultToolChoice && reminderToolChoice
								? { toolChoice: reminderToolChoice }
								: {}),
						});
						await session.waitForIdle();
						await pendingEventProcessing;
					} catch (err) {
						logger.error("Subagent prompt failed", {
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}

				await session.waitForIdle();
				await pendingEventProcessing;
				const lastAssistant = session.getLastAssistantMessage();
				if (lastAssistant) {
					if (lastAssistant.stopReason === "aborted") {
						aborted = abortReason === "signal" || abortReason === undefined;
						if (aborted) {
							abortReasonText ??= resolveSignalAbortReason();
						}
						exitCode = 1;
					} else if (lastAssistant.stopReason === "error") {
						exitCode = 1;
						error ??= lastAssistant.errorMessage || "Subagent failed";
					}
				}
				if (
					!submitResultCalled &&
					missingVerificationFailures &&
					(!abortSignal.aborted || abortReason === "terminate") &&
					!aborted &&
					!error
				) {
					const verificationMessage = buildMissingVerificationProofMessage(missingVerificationFailures);
					abortReasonText ??= verificationMessage;
					error = verificationMessage;
					exitCode = 1;
				} else if (
					!submitResultCalled &&
					(!abortSignal.aborted || abortReason === "terminate") &&
					!aborted &&
					!error
				) {
					abortReasonText ??= SUBAGENT_WARNING_MISSING_SUBMIT_RESULT;
					error = SUBAGENT_WARNING_MISSING_SUBMIT_RESULT;
				}
				break;
			}
		} catch (err) {
			exitCode = 1;
			if (!abortSignal.aborted) {
				error = err instanceof Error ? err.stack || err.message : String(err);
			}
		} finally {
			if (abortSignal.aborted) {
				aborted = abortReason === "signal" || abortReason === undefined;
				if (aborted) {
					abortReasonText ??= resolveSignalAbortReason();
				}
				if (exitCode === 0) exitCode = 1;
			}
			sessionAbortController.abort();
			if (unsubscribe) {
				try {
					unsubscribe();
				} catch {
					// Ignore unsubscribe errors
				}
				unsubscribe = null;
			}
			if (activeSession) {
				const session = activeSession;
				activeSession = null;
				try {
					await untilAborted(AbortSignal.timeout(5000), () => session.dispose());
				} catch {
					// Ignore cleanup errors
				}
			}
		}

		return {
			exitCode,
			error,
			aborted,
			abortReason: aborted ? abortReasonText : undefined,
			durationMs: Date.now() - startTime,
		};
	};

	const done = await runSubagent();
	await pendingEventProcessing;
	resolved = true;
	listenerController.abort();
	heartbeat.stop();

	if (progressTimeoutId) {
		clearTimeout(progressTimeoutId);
		progressTimeoutId = null;
	}

	let exitCode = done.exitCode;
	if (done.error) {
		stderr = done.error;
	}

	// Use final output if available, otherwise accumulated output
	let rawOutput = finalOutputChunks.length > 0 ? finalOutputChunks.join("") : outputChunks.join("");
	const submitResultItems = progress.extractedToolData?.submit_result as SubmitResultItem[] | undefined;
	const reportFindings = progress.extractedToolData?.report_finding as ReviewFinding[] | undefined;
	const finalized = finalizeSubprocessOutput({
		rawOutput,
		exitCode,
		stderr,
		doneAborted: Boolean(done.aborted),
		signalAborted: Boolean(signal?.aborted),
		submitResultItems,
		reportFindings,
		outputSchema,
	});
	rawOutput = finalized.rawOutput;
	exitCode = finalized.exitCode;
	stderr = finalized.stderr;
	const lastSubmitResult = submitResultItems?.[submitResultItems.length - 1];
	const submitResultAbortReason =
		lastSubmitResult?.status === "aborted" ? lastSubmitResult.error || "Subagent aborted task" : undefined;
	const { abortedViaSubmitResult, hasSubmitResult } = finalized;
	const { content: truncatedOutput } = truncateTail(rawOutput, {
		maxBytes: MAX_OUTPUT_BYTES,
		maxLines: MAX_OUTPUT_LINES,
	});

	// Write output artifact (input and jsonl already written in real-time)
	// Compute output metadata for agent:// URL integration
	let outputMeta: { lineCount: number; charCount: number } | undefined;
	let outputPath: string | undefined;
	if (options.artifactsDir) {
		outputPath = path.join(options.artifactsDir, `${id}.md`);
		try {
			await Bun.write(outputPath, rawOutput);
			outputMeta = {
				lineCount: rawOutput.split("\n").length,
				charCount: rawOutput.length,
			};
		} catch {
			// Non-fatal
		}
	}

	// Update final progress
	const missingSubmitResultWarning = !hasSubmitResult && rawOutput.startsWith(SUBAGENT_WARNING_MISSING_SUBMIT_RESULT);
	const missingSubmitResultFailed = missingSubmitResultWarning && progress.toolCount === 0;
	if (missingSubmitResultFailed) {
		exitCode = 1;
		stderr = SUBAGENT_WARNING_MISSING_SUBMIT_RESULT;
	}
	const wasAborted = abortedViaSubmitResult || (!hasSubmitResult && (done.aborted || signal?.aborted || false));
	const finalAbortReason = wasAborted
		? abortedViaSubmitResult
			? submitResultAbortReason
			: (done.abortReason ?? (signal?.aborted ? resolveSignalAbortReason() : "Subagent aborted task"))
		: undefined;
	const structuredResult = (() => {
		if (
			lastSubmitResult?.status === "success" &&
			lastSubmitResult.data !== undefined &&
			lastSubmitResult.data !== null
		) {
			return normalizeCompleteData(lastSubmitResult.data, reportFindings);
		}
		if (exitCode === 0 && !wasAborted) {
			return resolveFallbackCompletion(rawOutput, outputSchema)?.data;
		}
		return undefined;
	})();
	const structuredText = stringifyStructuredResult(structuredResult);
	const textPreview =
		buildTextPreview(truncatedOutput) ?? buildTextPreview(structuredText) ?? buildTextPreview(stderr);
	const spawnAudit = parseSpawnAudit(textPreview) ?? parseSpawnAudit(stderr);
	const outcome: SubagentOutcome = wasAborted
		? "aborted"
		: spawnAudit?.reason === "policy-rejected"
			? "policy-rejected"
			: missingSubmitResultWarning
				? "submit-result-missing"
				: exitCode === 0
					? structuredResult !== undefined || textPreview
						? "completed"
						: "completed-empty"
					: stderr.includes("Output does not match schema")
						? "schema-invalid"
						: lastSubmitResult?.status === "success" && lastSubmitResult.gateAccepted === false
							? "gate_failed"
							: "failed";
	progress.status = outcome;
	scheduleProgress(true);

	return {
		index,
		id,
		agent: agent.name,
		agentSource: agent.source,
		task,
		assignment,
		description: options.description,
		lastIntent: progress.lastIntent,
		exitCode,
		outcome,
		stderr,
		resultUri: `agent://${id}`,
		structuredResult,
		textPreview,
		children: nestedTaskResults.length > 0 ? nestedTaskResults : undefined,
		durationMs: Date.now() - startTime,
		tokens: progress.tokens,
		modelOverride,
		error: exitCode !== 0 && stderr ? stderr : undefined,
		aborted: wasAborted,
		abortReason: finalAbortReason,
		sessionId: progress.sessionId,
		transcriptUri: progress.transcriptPath,
		todoGroups: progress.todoGroups ? cloneTodoGroups(progress.todoGroups) : undefined,
		usage: hasUsage ? accumulatedUsage : undefined,
		outputPath,
		extractedToolData: progress.extractedToolData,
		outputMeta,
		spawnAudit,
		gateFailures: lastSubmitResult?.gateFailures,
	};
}

import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { GatewayClient } from "@oh-my-pi/pi-gateway";
import { logger } from "@oh-my-pi/pi-utils";
import type { AsyncJobManager } from "../async";
import type { PromptTemplate } from "../config/prompt-templates";
import type { Settings } from "../config/settings";
import type { TaskPolicy } from "../config/task-policies";
import type { Skill } from "../extensibility/skills";
import type { InternalUrlRouter } from "../internal-urls";

import type { LoopManager } from "../loop/loop-manager";
import { LoopDoneTool, LoopLaunchTool, LoopPrepareTool } from "../loop/loop-tools";
import { LspTool } from "../lsp";
import type { DiscoverableMCPSearchIndex, DiscoverableMCPTool } from "../mcp/discoverable-tool-metadata";
import type { CanvasOrchestratorManager } from "../orchestrators/canvas-orchestrator";
import type { CanvasTaskManager } from "../orchestrators/canvas-task-manager";

import type { ActiveModeState, PlanModeState } from "../plan-mode/state";
import type { SandboxPolicy } from "../sandbox";
import type { ArtifactRef } from "../session/artifacts";
import { TaskTool } from "../task";
import type { AgentOutputManager } from "../task/output-manager";
import type { EventBus } from "../utils/event-bus";
import { SearchTool } from "../web/search";
import { ApprovalsTool } from "./approvals-tool";
import { AskTool } from "./ask";

import { AutonomyStateTool } from "./autonomy-state";
import { AwaitTool } from "./await-tool";
import { BashTool } from "./bash";
import { BrowserTool } from "./browser";
import { CalculatorTool } from "./calculator";
import { CancelJobTool } from "./cancel-job";
import { CanvasTool } from "./canvas";
import { CanvasCastTool } from "./canvas-cast";
import { type CheckpointState, CheckpointTool, RewindTool } from "./checkpoint";

import { CreateTool } from "./create";
import { CodepathEditTool } from "./edit";
import { ExitPlanModeTool } from "./exit-plan-mode";
import { FetchTool } from "./fetch";

import { GatewayTool } from "./gateway";
import { GetTool } from "./get";
import { GoalsTool } from "./goals-tool";

import { InspectImageTool } from "./inspect-image";
import { ManageTool } from "./manage";
import { OrgTool } from "./org";
import { wrapToolWithMetaNotice } from "./output-meta";

import { RenderMermaidTool } from "./render-mermaid";
import { ResolveTool } from "./resolve";
import { reportFindingTool } from "./review";
import { SearchToolBm25Tool } from "./search-tool-bm25";
import { SendFileTool } from "./send-file";
import { loadSshTool } from "./ssh";
import { SubmitResultTool } from "./submit-result";
import { type TodoGroup, TodoWriteTool } from "./todo-write";

// Exa MCP tools (22 tools)

export * from "../exa";
export type * from "../exa/types";
export * from "../loop/loop-tools";
export * from "../lsp";
export * from "../patch";
export * from "../sandbox";
export * from "../session/streaming-output";
export * from "../task";
export * from "../web/search";
export * from "./approvals-tool";
export * from "./ask";

export * from "./autonomy-state";
export * from "./await-tool";
export * from "./bash";
export * from "./browser";
export * from "./calculator";
export * from "./cancel-job";
export * from "./canvas";
export * from "./canvas-cast";
export * from "./checkpoint";

export * from "./codepath-result";
export * from "./codepath-types";
export * from "./context-pressure-policy";
export * from "./create";
export * from "./edit";
export * from "./exit-plan-mode";
export * from "./fetch";

export * from "./gateway";
export * from "./gemini-image";
export * from "./get";
export * from "./goals-tool";

export * from "./inspect-image";
export * from "./manage";
export * from "./pending-action";

export * from "./render-mermaid";
export * from "./resolve";
export * from "./review";
export * from "./search-tool-bm25";
export * from "./send-file";
export * from "./ssh";
export * from "./submit-result";
export * from "./todo-write";

/** Tool type (AgentTool from pi-ai) */
export type Tool = AgentTool<any, any, any>;

export type ContextFileEntry = {
	path: string;
	content: string;
	depth?: number;
};

export type { DiscoverableMCPTool } from "../mcp/discoverable-tool-metadata";

/** Session context for tool factories */
export interface ToolSession {
	/** Current working directory */
	cwd: string;
	/** Whether UI is available */
	hasUI: boolean;

	/** Pre-loaded context files (AGENTS.md, etc) */
	contextFiles?: ContextFileEntry[];
	/** Pre-loaded skills */
	skills?: Skill[];
	/** Pre-loaded prompt templates */
	promptTemplates?: PromptTemplate[];
	/** Whether LSP integrations are enabled */
	enableLsp?: boolean;
	/** Optional sandbox policy constraining file writes and bash commands */
	sandboxPolicy?: SandboxPolicy;
	/** Whether the edit tool is available in this session (controls hashline output) */
	hasEditTool?: boolean;
	/** Event bus for tool/extension communication */
	eventBus?: EventBus;
	/** Output schema for structured completion (subagents) */
	outputSchema?: unknown;
	/** Whether to include the submit_result tool by default */
	requireSubmitResultTool?: boolean;
	/** Task recursion depth (0 = top-level, 1 = first child, etc.) */
	taskDepth?: number;
	/** Get session file */
	getSessionFile: () => string | null;
	/** Get session ID */
	getSessionId?: () => string | null;
	/** Get the active agent system prompt (empty string before agent starts). */
	getSystemPrompt?: () => string;
	/** Get the first user message that initiated the session. */
	getFirstUserMessage?: () => string | undefined;
	/** Get artifacts directory for artifact:// URLs */
	getArtifactsDir?: () => string | null;
	/** Allocate a new artifact path, URI, and ID for session-scoped output. */
	allocateOutputArtifact?: (toolType: string, extension?: string) => Promise<ArtifactRef | undefined>;
	/** Get session spawns */
	getSessionSpawns: () => string | null;
	/** Get resolved model string if explicitly set for this session */
	getModelString?: () => string | undefined;
	/** Get the current session model string, regardless of how it was chosen */
	getActiveModelString?: () => string | undefined;
	/** Auth storage for passing to subagents (avoids re-discovery) */
	authStorage?: import("../session/auth-storage").AuthStorage;
	/** Model registry for passing to subagents (avoids re-discovery) */
	modelRegistry?: import("../config/model-registry").ModelRegistry;
	/** MCP manager for proxying MCP calls through parent */
	mcpManager?: import("../mcp/manager").MCPManager;
	/** Internal URL router for protocols like agent://, skill://, and mcp:// */
	internalRouter?: InternalUrlRouter;
	/** Agent output manager for unique agent:// IDs across task invocations */
	agentOutputManager?: AgentOutputManager;
	/** Async background job manager for bash/task async execution */
	asyncJobManager?: AsyncJobManager;
	/** Settings instance for passing to subagents */
	settings: Settings;
	/** Plan mode state (if active) @deprecated Use getActiveModeState */
	getPlanModeState?: () => PlanModeState | undefined;
	/** Last plan approved in this session, if any. */
	getLastApprovedPlan?: () => { itemId?: string; title: string; finalPlanFilePath: string } | undefined;
	/** Active mode state (plan, audit, or user-defined) */
	getActiveModeState?: () => ActiveModeState | undefined;
	/** Whether the agent is currently idle (not streaming a turn). */
	isAgentIdle?: () => boolean;
	/** Get compact conversation context for subagents (excludes tool results, system prompts) */
	getCompactContext?: () => string;
	/** Get cached todo groups for this session. */
	getTodoGroups?: () => TodoGroup[];
	/** Replace cached todo groups for this session. */
	setTodoGroups?: (groups: TodoGroup[], options?: { reset?: boolean }) => void;
	/** Whether MCP tool discovery is active for this session. */
	isMCPDiscoveryEnabled?: () => boolean;
	/** Get hidden-but-discoverable MCP tools for search_tool_bm25 prompts and fallbacks. */
	getDiscoverableMCPTools?: () => DiscoverableMCPTool[];
	/** Get the cached discoverable MCP search index for search_tool_bm25 execution. */
	getDiscoverableMCPSearchIndex?: () => DiscoverableMCPSearchIndex;
	/** Get MCP tools activated by prior search_tool_bm25 calls. */
	getSelectedMCPToolNames?: () => string[];
	/** Merge MCP tool selections into the active session tool set. */
	activateDiscoveredMCPTools?: (toolNames: string[]) => Promise<string[]>;
	/** Pending action store for preview/apply workflows */
	pendingActionStore?: import("./pending-action").PendingActionStore;
	/** Get active checkpoint state if any. */
	getCheckpointState?: () => CheckpointState | undefined;
	/** Set or clear active checkpoint state. */
	setCheckpointState?: (state: CheckpointState | null) => void;
	/** Dedicated org-mode daemon lifecycle manager for org MCP callers. */
	/** Active QML remote server; when set, CanvasTool routes panels to the Android client. */
	qmlRemoteServer?: import("@oh-my-pi/pi-qml-remote").QmlRemoteServer;
	/** Loop orchestration manager for loop tools, slash commands, and dashboards. */
	loopManager?: LoopManager;
	/** Canvas orchestrator manager for canvas-backed QML windows. */
	orchestratorManager?: CanvasOrchestratorManager;
	/** Canvas task manager for canvas-backed QML windows. */
	taskManager?: CanvasTaskManager;
	/** Dispose session-owned resources (QML remote server). */
	dispose?(): Promise<void> | void;
	/** Reset session-specific state while preserving long-lived resources. */
	softReset?(): Promise<void> | void;
	/** Gateway client for managing .localhost service aliases */
	gatewayClient?: GatewayClient;
	/** Resolved task policies (project + mode merged). Cached per session. */
	getResolvedTaskPolicies?: () => TaskPolicy[];
	/** Get accumulated bash tool execution history for this session. */
	getBashHistory?: () => ReadonlyArray<import("../task/gate-verification").TrackedBashExecution>;
	/** Capture a git baseline for the session cwd. Returns null outside a git repo. */
	captureGitBaseline?: () => Promise<import("../session/git-baseline").GitBaseline | null>;
	/** Compare current working-tree against a previously captured baseline. Returns null when evidence is unavailable. */
	compareGitBaseline?: (
		baseline: import("../session/git-baseline").GitBaseline,
	) => Promise<import("../session/git-baseline").GitBaselineDiff | null>;
}

type ToolFactory = (session: ToolSession) => Tool | null | Promise<Tool | null>;

export const BUILTIN_TOOLS: Record<string, ToolFactory> = {
	render_mermaid: s => new RenderMermaidTool(s),
	ask: AskTool.createIf,
	bash: s => new BashTool(s),

	calc: s => new CalculatorTool(s),
	ssh: loadSshTool,
	// biome-ignore lint/suspicious/noDuplicateObjectKeys: coexistence override; new registration below
	// edit: s => new EditTool(s), // Replaced by CodepathEditTool below

	lsp: LspTool.createIf,

	inspect_image: s => new InspectImageTool(s),
	browser: s => new BrowserTool(s),
	checkpoint: CheckpointTool.createIf,
	rewind: RewindTool.createIf,
	task: TaskTool.create,
	cancel_job: CancelJobTool.createIf,
	await: AwaitTool.createIf,
	todo_write: s => new TodoWriteTool(s),
	org: s => new OrgTool(s),
	fetch: s => new FetchTool(s),
	web_search: s => new SearchTool(s),
	search_tool_bm25: SearchToolBm25Tool.createIf,
	goals: GoalsTool.createIf,
	approvals: ApprovalsTool.createIf,

	send_file: s => new SendFileTool(s),
	canvas: s => new CanvasTool(s),
	canvas_cast: CanvasCastTool.createIf,
	loop_prepare: s => (s.loopManager ? new LoopPrepareTool(s) : null),
	loop_launch: s => (s.loopManager ? new LoopLaunchTool(s) : null),
	loop_done: s => (s.loopManager ? new LoopDoneTool(s) : null),
	gateway: GatewayTool.createIf,
	// Generic code-path tools (coexistence wave; override legacy registrations)
	get: () => new GetTool(),
	manage: () => new ManageTool(),
	create: s => new CreateTool(s),
	edit: s => new CodepathEditTool(s),
};

export type ToolTier = "core" | "standard" | "specialized";

export const TOOL_TIERS: Record<string, ToolTier> = {
	// Core — always loaded, essential for any task
	grep: "core",
	find: "core",
	bash: "core",
	lsp: "core",
	code: "core",
	task: "core",
	ask: "core",

	// Standard — loaded by default, common development tools
	read: "standard",
	edit: "standard",
	write: "standard",
	ast_grep: "standard",
	ast_edit: "standard",
	todo_write: "standard",
	org: "standard",
	fetch: "standard",
	web_search: "standard",
	cancel_job: "standard",
	await: "standard",
	canvas_cast: "standard",
	goals: "standard",
	approvals: "standard",

	// Standard — loaded by default
	get: "standard",
	manage: "standard",
	create: "standard",

	// Specialized — compact API descriptions to reduce token usage
	canvas: "specialized",

	render_mermaid: "specialized",
	ssh: "specialized",
	inspect_image: "specialized",
	browser: "specialized",
	checkpoint: "specialized",
	rewind: "specialized",
	calc: "specialized",
	loop_prepare: "specialized",
	loop_launch: "specialized",
	loop_done: "specialized",
	gateway: "specialized",
	search_tool_bm25: "specialized",
	send_file: "specialized",
};

/** Get the tool tier, defaulting to "standard" for unknown tools (e.g. MCP tools). */
export function getToolTier(toolName: string): ToolTier {
	return TOOL_TIERS[toolName] ?? "standard";
}

/**
 * Extract a compact one-liner from a tool's full description.
 * Returns the first sentence (up to the first period followed by whitespace/newline).
 * Falls back to truncating at 120 chars if no sentence boundary is found.
 */
export function compactToolDescription(description: string): string {
	if (!description) return "";
	// Strip leading XML/markdown tags and whitespace
	const cleaned = description.replace(/^\s*<[^>]+>\s*/g, "").trim();
	// Find first sentence boundary (period followed by space, newline, or end)
	const match = cleaned.match(/^(.+?\.)(\s|\n|$)/);
	if (match) return match[1].trim();
	// No sentence found — truncate
	if (cleaned.length <= 120) return cleaned;
	return `${cleaned.slice(0, 117)}...`;
}

export const HIDDEN_TOOLS: Record<string, ToolFactory> = {
	autonomy_state: AutonomyStateTool.createIf,
	submit_result: s => new SubmitResultTool(s),
	report_finding: () => reportFindingTool,
	exit_plan_mode: s => new ExitPlanModeTool(s),
	resolve: s => new ResolveTool(s),
};

export type ToolName = keyof typeof BUILTIN_TOOLS;

/**
 * Create tools from BUILTIN_TOOLS registry.
 */
export async function createTools(session: ToolSession, toolNames?: string[]): Promise<Tool[]> {
	const includeSubmitResult = session.requireSubmitResultTool === true;
	const enableLsp = session.enableLsp ?? true;
	const requestedTools =
		toolNames && toolNames.length > 0 ? [...new Set(toolNames.map(name => name.toLowerCase()))] : undefined;
	if (requestedTools && !requestedTools.includes("exit_plan_mode")) {
		requestedTools.push("exit_plan_mode");
	}

	// Auto-include AST counterparts when their text-based sibling is present
	if (requestedTools) {
		if (
			requestedTools.includes("grep") &&
			!requestedTools.includes("ast_grep") &&
			session.settings.get("astGrep.enabled")
		) {
			requestedTools.push("ast_grep");
		}
		if (
			requestedTools.includes("edit") &&
			!requestedTools.includes("ast_edit") &&
			session.settings.get("astEdit.enabled")
		) {
			requestedTools.push("ast_edit");
		}
	}
	const allTools: Record<string, ToolFactory> = {
		...BUILTIN_TOOLS,
		...HIDDEN_TOOLS,
	};
	const isToolAllowed = (name: string) => {
		const inPlanMode = session.getPlanModeState?.()?.enabled === true;
		// Plan mode mandates org and todo_write in its context prompt — force them on
		// regardless of settings toggles so the instructions are satisfiable.
		if (name === "org" && inPlanMode) return true;
		if (name === "org") return !!session.settings.get("org.enabled");
		if (name === "todo_write" && inPlanMode) return true;
		if (name === "lsp") return enableLsp;

		if (name === "todo_write") return session.settings.get("todo.enabled");
		if (name === "find") return session.settings.get("find.enabled");
		if (name === "grep") return session.settings.get("grep.enabled");
		if (name === "ast_grep") return session.settings.get("astGrep.enabled");
		if (name === "ast_edit") return session.settings.get("astEdit.enabled");
		if (name === "render_mermaid") return session.settings.get("renderMermaid.enabled");

		if (name === "inspect_image") return session.settings.get("inspect_image.enabled");
		if (name === "fetch") return session.settings.get("fetch.enabled");
		if (name === "web_search") return session.settings.get("web_search.enabled");
		if (name === "search_tool_bm25") return session.settings.get("mcp.discoveryMode");
		if (name === "lsp") return session.settings.get("lsp.enabled");
		if (name === "calc") return session.settings.get("calc.enabled");
		if (name === "browser") return session.settings.get("browser.enabled");
		if (name === "checkpoint" || name === "rewind") return session.settings.get("checkpoint.enabled");
		if (name === "task") {
			const maxDepth = session.settings.get("task.maxRecursionDepth") ?? 3;
			const currentDepth = session.taskDepth ?? 0;
			return maxDepth < 0 || currentDepth < maxDepth;
		}
		return true;
	};
	if (includeSubmitResult && requestedTools && !requestedTools.includes("submit_result")) {
		requestedTools.push("submit_result");
	}

	const filteredRequestedTools = requestedTools?.filter(name => name in allTools && isToolAllowed(name));
	const baseEntries =
		filteredRequestedTools !== undefined
			? filteredRequestedTools.filter(name => name !== "resolve").map(name => [name, allTools[name]] as const)
			: [
					...Object.entries(BUILTIN_TOOLS).filter(([name]) => isToolAllowed(name)),
					...(includeSubmitResult ? ([["submit_result", HIDDEN_TOOLS.submit_result]] as const) : []),
					...([["exit_plan_mode", HIDDEN_TOOLS.exit_plan_mode]] as const),
				];

	const baseResults = await Promise.all(
		baseEntries.map(async ([name, factory]) => {
			const tool = await logger.timeAsync(`createTools:${name}`, factory, session);
			return tool ? wrapToolWithMetaNotice(tool) : null;
		}),
	);
	const tools = baseResults.filter((r): r is Tool => r !== null);
	const hasDeferrableTools = tools.some(tool => tool.deferrable === true);
	if (!hasDeferrableTools) {
		return tools;
	}
	if (tools.some(tool => tool.name === "resolve")) {
		return tools;
	}
	const resolveTool = await logger.timeAsync("createTools:resolve", HIDDEN_TOOLS.resolve, session);
	if (resolveTool) {
		tools.push(wrapToolWithMetaNotice(resolveTool));
	}
	return tools;
}

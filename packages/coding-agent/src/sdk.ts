import * as path from "node:path";

import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	type AgentToolResult,
	INTENT_FIELD,
	type ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import type { Message, Model, SystemPromptBlock } from "@oh-my-pi/pi-ai";
import { prewarmOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { GatewayClient } from "@oh-my-pi/pi-gateway";
import type { Component } from "@oh-my-pi/pi-tui";
import { $env, getAgentDbPath, getAgentDir, getProjectDir, logger, postmortem } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import { AsyncJobManager } from "./async";
import { loadCapability } from "./capability";
import { setupCallbackSchemes } from "./scheme-bootstrap";
import { type ModeConfig, modeConfigCapability, type ResolvedModeConfig } from "./capability/mode";
import { type Rule, ruleCapability } from "./capability/rule";
import { ModelRegistry } from "./config/model-registry";
import { formatModelString, parseModelPattern, parseModelString, resolveModelRoleValue } from "./config/model-resolver";
import {
	loadPromptTemplates as loadPromptTemplatesInternal,
	type PromptTemplate,
	renderPromptTemplate,
} from "./config/prompt-templates";
import { Settings, type SkillsSettings } from "./config/settings";
import { CursorExecHandlers } from "./cursor";
import { resolveModeConfig } from "./discovery/mode-helpers";
import "./discovery";
import { buildServicePromptSection } from "./browser/service-prompt-section";
import { resolveConfigValue } from "./config/resolve-config-value";
import { loadMergedProviderConfigs } from "./config/spell-kdl";
import { loadTaskPolicies, mergePolicies, type TaskPolicy } from "./config/task-policies";
import { initializeWithSettings } from "./discovery";
import type { SpellDomain } from "./domain/loader";
import { applyDomainToolPolicy, loadDomainPromptContext } from "./domain/policy";
import { TtsrManager } from "./export/ttsr";
import {
	type CustomCommandsLoadResult,
	type LoadedCustomCommand,
	loadCustomCommands as loadCustomCommandsInternal,
} from "./extensibility/custom-commands";
import { discoverAndLoadCustomTools } from "./extensibility/custom-tools";
import type { CustomTool, CustomToolContext, CustomToolSessionEvent } from "./extensibility/custom-tools/types";
import { CustomToolAdapter } from "./extensibility/custom-tools/wrapper";
import {
	discoverAndLoadExtensions,
	type ExtensionContext,
	type ExtensionFactory,
	ExtensionRunner,
	ExtensionToolWrapper,
	type ExtensionUIContext,
	type LoadExtensionsResult,
	loadExtensionFromFactory,
	loadExtensions,
	type ToolDefinition,
	wrapRegisteredTools,
} from "./extensibility/extensions";
import { createCavemanExtension } from "./extensibility/extensions/caveman";
import { loadSkills as loadSkillsInternal, type Skill, type SkillWarning } from "./extensibility/skills";
import { type FileSlashCommand, loadSlashCommands as loadSlashCommandsInternal } from "./extensibility/slash-commands";
import {
	AgentProtocolHandler,

	CanvasProtocolHandler,
	createTaskUriProtocolHandlers,
	InternalUrlRouter,

	LocalProtocolHandler,
	McpProtocolHandler,
	MemoryProtocolHandler,
	OrgProtocolHandler,
	PiProtocolHandler,

} from "./internal-urls";

import { LoopManager } from "./loop/loop-manager";
import { discoverAndLoadMCPTools, type MCPManager, type MCPToolsLoadResult } from "./mcp";
import {
	collectDiscoverableMCPTools,
	formatDiscoverableMCPToolServerSummary,
	summarizeDiscoverableMCPTools,
} from "./mcp/discoverable-tool-metadata";
import { buildMemoryToolDeveloperInstructions, getMemoryRoot, startMemoryStartupTask } from "./memories";
import { CanvasOrchestratorManager } from "./orchestrators/canvas-orchestrator";
import { CanvasTaskManager } from "./orchestrators/canvas-task-manager";
import asyncResultTemplate from "./prompts/tools/async-result.md" with { type: "text" };
import { collectEnvSecrets, loadSecrets, obfuscateMessages, SecretObfuscator } from "./secrets";
import { AgentSession } from "./session/agent-session";
import { AuthStorage } from "./session/auth-storage";
import { convertToLlm } from "./session/messages";
import { SessionManager } from "./session/session-manager";
import type { SpellcastSessionContext } from "./spellcast";
import { validateSpellcastingToken } from "./spellcast/config";
import { discoverSpellcastManifests } from "./spellcast/discovery";
import { formatSpellcastSessionReport } from "./spellcast/session-report";
import { loadSpellcastPublishState } from "./spellcast/state";
import { checkFileAgainstManifests, extractModifiedPaths, formatSpellcastSyncNote } from "./spellcast/sync-detector";
import { closeAllConnections } from "./ssh/connection-manager";
import { unmountAll } from "./ssh/sshfs-mount";
import {
	buildAgentsMdSearch,
	buildSystemPrompt as buildSystemPromptInternal,
	buildSystemPromptToolMetadata,
	loadProjectContextFiles as loadContextFilesInternal,
	loadSystemPromptFiles,
	raceWithTimeout,
} from "./system-prompt";
import { AgentOutputManager } from "./task/output-manager";
import { parseThinkingLevel, resolveThinkingLevelForModel, toReasoningEffort } from "./thinking";
import {
	BashTool,
	BUILTIN_TOOLS,
	compactToolDescription,
	createTools,
	getSearchTools,
	getToolTier,
	HIDDEN_TOOLS,
	isCodeSearchProviderId,
	isSearchProviderPreference,
	loadSshTool,
	ResolveTool,
	renderSearchToolBm25Description,
	setPreferredCodeSearchProvider,
	setPreferredImageProvider,
	setPreferredSearchProvider,
	type Tool,
	type ToolSession,

} from "./tools";
import {
	CANVAS_AGENT_CHANNEL,
	CANVAS_EVENTS_CHANNEL,
	CANVAS_TOOL_INVOKE_CHANNEL,
	type CanvasAgentPayload,
	type CanvasToolInvokePayload,
	type CanvasWindowEventsPayload,
} from "./tools/canvas";
import { ToolContextStore } from "./tools/context";
import { getGeminiImageTools } from "./tools/gemini-image";
import { wrapToolWithMetaNotice } from "./tools/output-meta";
import { PendingActionStore } from "./tools/pending-action";
import { EventBus } from "./utils/event-bus";

// Types
export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: getProjectDir() */
	cwd?: string;
	/** Global config directory. Default: ~/.spell/agent */
	agentDir?: string;
	/** Spawns to allow. Default: "*" */
	spawns?: string;

	/** Auth storage for credentials. Default: discoverAuthStorage(agentDir) */
	authStorage?: AuthStorage;
	/** Model registry. Default: discoverModels(authStorage, agentDir) */
	modelRegistry?: ModelRegistry;

	/** Model to use. Default: from settings, else first available */
	model?: Model;
	/** Raw model pattern string (e.g. from --model CLI flag) to resolve after extensions load.
	 * Used when model lookup is deferred because extension-provided models aren't registered yet. */
	modelPattern?: string;
	/** Thinking selector. Default: from settings, else unset */
	thinkingLevel?: ThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;

	/** System prompt. String replaces default, function receives default blocks and returns final prompt. */
	systemPrompt?: string | ((defaultBlocks: SystemPromptBlock[]) => SystemPromptBlock[] | string);

	/** Custom tools to register (in addition to built-in tools). Accepts both CustomTool and ToolDefinition. */
	customTools?: (CustomTool | ToolDefinition)[];
	/** Inline extensions (merged with discovery). */
	extensions?: ExtensionFactory[];
	/** Additional extension paths to load (merged with discovery). */
	additionalExtensionPaths?: string[];
	/** Disable extension discovery (explicit paths still load). */
	disableExtensionDiscovery?: boolean;
	/**
	 * Pre-loaded extensions (skips file discovery).
	 * @internal Used by CLI when extensions are loaded early to parse custom flags.
	 */
	preloadedExtensions?: LoadExtensionsResult;

	/** Shared event bus for tool/extension communication. Default: creates new bus.
	 * Kept untyped because the session bus carries non-swarm channels and must remain
	 * open to all modules. Swarm-specific typing is applied only at local call sites.
	 */
	eventBus?: EventBus;

	/** Skills. Default: discovered from multiple locations */
	skills?: Skill[];
	/** Rules. Default: discovered from multiple locations */
	rules?: Rule[];
	/** Context files (AGENTS.md content). Default: discovered walking up from cwd */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Active domain manifest applied to this session. */
	domainManifest?: SpellDomain;
	/** Prompt templates. Default: discovered from cwd/.spell/prompts/ + agentDir/prompts/ */
	promptTemplates?: PromptTemplate[];
	/** File-based slash commands. Default: discovered from commands/ directories */
	slashCommands?: FileSlashCommand[];

	/** Enable MCP server discovery from .mcp.json files. Default: true */
	enableMCP?: boolean;


	/** Optional sandbox policy constraining file writes and bash commands for this session */
	sandboxPolicy?: import("./sandbox").SandboxPolicy;
	/** Skip Python kernel availability check and prelude warmup */

	/** Tool names explicitly requested (enables disabled-by-default tools) */
	toolNames?: string[];

	/** Output schema for structured completion (subagents) */
	outputSchema?: unknown;
	/** Whether to include the submit_result tool by default */
	requireSubmitResultTool?: boolean;
	/** Task recursion depth (for subagent sessions). Default: 0 */
	taskDepth?: number;
	/** Parent task ID prefix for nested artifact naming (e.g., "6-Extensions") */
	parentTaskPrefix?: string;

	/** Session manager. Default: session stored under the configured agentDir sessions root */
	sessionManager?: SessionManager;

	/** Settings instance. Default: Settings.init({ cwd, agentDir }) */
	settings?: Settings;

	/** Whether UI is available (enables interactive tools like ask). Default: false */
	hasUI?: boolean;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (loaded extensions + runtime) */
	extensionsResult: LoadExtensionsResult;
	/** Update tool UI context (interactive mode) */
	setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	/** MCP manager for server lifecycle management (undefined if MCP disabled) */
	mcpManager?: MCPManager;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
	/** Discovered spellcast manifests and loaded publish-state for this session */
	spellcastSessionContext?: SpellcastSessionContext;
	/** User-facing spellcast discovery summary for session start notifications */
	spellcastReport?: string;
	/** Warning emitted when stored spellcasting auth is invalid or unreachable */
	spellcastingWarning?: string;

	/** EventBus instance for inter-module communication */
	eventBus?: EventBus;
	/** Canvas orchestrator manager (undefined if no canvas support) */
	orchestratorManager?: CanvasOrchestratorManager;
	/** Canvas task manager for dispatching task subagents from QML windows. */
	taskManager?: CanvasTaskManager;
	/** Loop orchestration manager for loop lifecycle, gates, and dashboards. */
	loopManager?: LoopManager;
}

// Re-exports

export type { PromptTemplate } from "./config/prompt-templates";
export { Settings, type SkillsSettings } from "./config/settings";
export type { CustomCommand, CustomCommandFactory } from "./extensibility/custom-commands/types";
export type { CustomTool, CustomToolFactory } from "./extensibility/custom-tools/types";
export type * from "./extensibility/extensions";
export type { Skill } from "./extensibility/skills";
export type { FileSlashCommand } from "./extensibility/slash-commands";
export type { MCPManager, MCPServerConfig, MCPServerConnection, MCPToolsLoadResult } from "./mcp";
export type { Tool } from "./tools";

export {
	// Individual tool classes (for custom usage)
	BashTool,
	// Tool classes and factories
	BUILTIN_TOOLS,
	createTools,
	HIDDEN_TOOLS,
	loadSshTool,
	ResolveTool,
	type ToolSession,
};

// Helper Functions

function getDefaultAgentDir(): string {
	return getAgentDir();
}

// Discovery Functions

/**
 * Create an AuthStorage instance with fallback support.
 * Reads from primary path first, then falls back to legacy paths (.pi, .claude).
 */
export async function discoverAuthStorage(agentDir: string = getDefaultAgentDir()): Promise<AuthStorage> {
	const dbPath = getAgentDbPath(agentDir);
	logger.debug("discoverAuthStorage", { agentDir, dbPath });

	const storage = await AuthStorage.create(dbPath, { configValueResolver: resolveConfigValue });
	await storage.reload();
	return storage;
}

/**
 * Discover extensions from cwd.
 */
export async function discoverExtensions(cwd?: string): Promise<LoadExtensionsResult> {
	const resolvedCwd = cwd ?? getProjectDir();

	return discoverAndLoadExtensions([], resolvedCwd);
}

/**
 * Discover skills from cwd and agentDir.
 */
export async function discoverSkills(
	cwd?: string,
	_agentDir?: string,
	settings?: SkillsSettings,
): Promise<{ skills: Skill[]; warnings: SkillWarning[] }> {
	return await loadSkillsInternal({
		...settings,
		cwd: cwd ?? getProjectDir(),
	});
}

/**
 * Discover context files (AGENTS.md) walking up from cwd.
 * Returns files sorted by depth (farther from cwd first, so closer files appear last/more prominent).
 */
export async function discoverContextFiles(
	cwd?: string,
	_agentDir?: string,
): Promise<Array<{ path: string; content: string; depth?: number }>> {
	return await loadContextFilesInternal({
		cwd: cwd ?? getProjectDir(),
	});
}

/**
 * Discover prompt templates from cwd and agentDir.
 */
export async function discoverPromptTemplates(cwd?: string, agentDir?: string): Promise<PromptTemplate[]> {
	return await loadPromptTemplatesInternal({
		cwd: cwd ?? getProjectDir(),
		agentDir: agentDir ?? getDefaultAgentDir(),
	});
}

/**
 * Discover file-based slash commands from commands/ directories.
 */
export async function discoverSlashCommands(cwd?: string): Promise<FileSlashCommand[]> {
	return loadSlashCommandsInternal({ cwd: cwd ?? getProjectDir() });
}

/**
 * Discover custom commands (TypeScript slash commands) from cwd and agentDir.
 */
export async function discoverCustomTSCommands(cwd?: string, agentDir?: string): Promise<CustomCommandsLoadResult> {
	const resolvedCwd = cwd ?? getProjectDir();
	const resolvedAgentDir = agentDir ?? getDefaultAgentDir();

	return loadCustomCommandsInternal({
		cwd: resolvedCwd,
		agentDir: resolvedAgentDir,
	});
}

/**
 * Discover MCP servers from .mcp.json files.
 * Returns the manager and loaded tools.
 */
export async function discoverMCPServers(cwd?: string): Promise<MCPToolsLoadResult> {
	const resolvedCwd = cwd ?? getProjectDir();
	return discoverAndLoadMCPTools(resolvedCwd);
}

// API Key Helpers

// System Prompt

export interface BuildSystemPromptOptions {
	tools?: Tool[];
	skills?: Skill[];
	contextFiles?: Array<{ path: string; content: string }>;
	cwd?: string;
	appendPrompt?: string;
	repeatToolDescriptions?: boolean;
	autoRosterEnabled?: boolean;
	settings?: Settings;
	isSubagent?: boolean;
}

/**
 * Build the default system prompt.
 */
export async function buildSystemPrompt(options: BuildSystemPromptOptions = {}): Promise<SystemPromptBlock[]> {
	return await buildSystemPromptInternal({
		cwd: options.cwd,
		skills: options.skills,
		contextFiles: options.contextFiles,
		appendSystemPrompt: options.appendPrompt,
		repeatToolDescriptions: options.repeatToolDescriptions,
		autoRosterEnabled: options.autoRosterEnabled,
		settings: options.settings,
		isSubagent: options.isSubagent,
	});
}

// Internal Helpers

function createCustomToolContext(ctx: ExtensionContext): CustomToolContext {
	return {
		sessionManager: ctx.sessionManager,
		modelRegistry: ctx.modelRegistry,
		model: ctx.model,
		isIdle: ctx.isIdle,
		hasQueuedMessages: ctx.hasPendingMessages,
		abort: ctx.abort,
	};
}

function isCustomTool(tool: CustomTool | ToolDefinition): tool is CustomTool {
	// To distinguish, we mark converted tools with a hidden symbol property.
	// If the tool doesn't have this marker, it's a CustomTool that needs conversion.
	return !(tool as any).__isToolDefinition;
}

const TOOL_DEFINITION_MARKER = Symbol("__isToolDefinition");

let sshCleanupRegistered = false;

async function cleanupSshResources(): Promise<void> {
	const results = await Promise.allSettled([closeAllConnections(), unmountAll()]);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.warn("SSH cleanup failed", { error: String(result.reason) });
		}
	}
}

function registerSshCleanup(): void {
	if (sshCleanupRegistered) return;
	sshCleanupRegistered = true;
	postmortem.register("ssh-cleanup", cleanupSshResources);
}

function customToolToDefinition(tool: CustomTool): ToolDefinition {
	const definition: ToolDefinition & { [TOOL_DEFINITION_MARKER]: true } = {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		execute: (toolCallId, params, signal, onUpdate, ctx) =>
			tool.execute(toolCallId, params, onUpdate, createCustomToolContext(ctx), signal),
		onSession: tool.onSession ? (event, ctx) => tool.onSession?.(event, createCustomToolContext(ctx)) : undefined,
		renderCall: tool.renderCall,
		renderResult: tool.renderResult
			? (result, options, theme): Component => {
					const component = tool.renderResult?.(
						result,
						{ expanded: options.expanded, isPartial: options.isPartial, spinnerFrame: options.spinnerFrame },
						theme,
					);
					// Return empty component if undefined to match Component type requirement
					return component ?? ({ render: () => [] } as unknown as Component);
				}
			: undefined,
		[TOOL_DEFINITION_MARKER]: true,
	};
	return definition;
}

function createCustomToolsExtension(tools: CustomTool[]): ExtensionFactory {
	return api => {
		for (const tool of tools) {
			api.registerTool(customToolToDefinition(tool));
		}

		const runOnSession = async (event: CustomToolSessionEvent, ctx: ExtensionContext) => {
			for (const tool of tools) {
				if (!tool.onSession) continue;
				try {
					await tool.onSession(event, createCustomToolContext(ctx));
				} catch (err) {
					logger.warn("Custom tool onSession error", { tool: tool.name, error: String(err) });
				}
			}
		};

		api.on("session_start", async (_event, ctx) =>
			runOnSession({ reason: "start", previousSessionFile: undefined }, ctx),
		);
		api.on("session_switch", async (event, ctx) =>
			runOnSession({ reason: "switch", previousSessionFile: event.previousSessionFile }, ctx),
		);
		api.on("session_branch", async (event, ctx) =>
			runOnSession({ reason: "branch", previousSessionFile: event.previousSessionFile }, ctx),
		);
		api.on("session_tree", async (_event, ctx) =>
			runOnSession({ reason: "tree", previousSessionFile: undefined }, ctx),
		);
		api.on("session_shutdown", async (_event, ctx) =>
			runOnSession({ reason: "shutdown", previousSessionFile: undefined }, ctx),
		);
		api.on("auto_compaction_start", async (event, ctx) =>
			runOnSession({ reason: "auto_compaction_start", trigger: event.reason, action: event.action }, ctx),
		);
		api.on("auto_compaction_end", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_compaction_end",
					action: event.action,
					result: event.result,
					aborted: event.aborted,
					willRetry: event.willRetry,
					errorMessage: event.errorMessage,
				},
				ctx,
			),
		);
		api.on("auto_retry_start", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_retry_start",
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
				},
				ctx,
			),
		);
		api.on("auto_retry_end", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_retry_end",
					success: event.success,
					attempt: event.attempt,
					finalError: event.finalError,
				},
				ctx,
			),
		);
		api.on("ttsr_triggered", async (event, ctx) =>
			runOnSession({ reason: "ttsr_triggered", rules: event.rules }, ctx),
		);
		api.on("todo_reminder", async (event, ctx) =>
			runOnSession(
				{
					reason: "todo_reminder",
					todos: event.todos,
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
				},
				ctx,
			),
		);
	};
}

// Factory

/**
 * Build LoadedCustomCommand entries for all MCP prompts across connected servers.
 * These are re-created whenever prompts change (setOnPromptsChanged callback).
 */
function buildMCPPromptCommands(manager: MCPManager): LoadedCustomCommand[] {
	const commands: LoadedCustomCommand[] = [];
	for (const serverName of manager.getConnectedServers()) {
		const prompts = manager.getServerPrompts(serverName);
		if (!prompts?.length) continue;
		for (const prompt of prompts) {
			const commandName = `${serverName}:${prompt.name}`;
			commands.push({
				path: `mcp:${commandName}`,
				resolvedPath: `mcp:${commandName}`,
				source: "bundled",
				command: {
					name: commandName,
					description: prompt.description ?? `MCP prompt from ${serverName}`,
					async execute(args: string[]) {
						const promptArgs: Record<string, string> = {};
						for (const arg of args) {
							const eqIdx = arg.indexOf("=");
							if (eqIdx > 0) {
								promptArgs[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
							}
						}
						const result = await manager.executePrompt(serverName, prompt.name, promptArgs);
						if (!result) return "";
						const parts: string[] = [];
						for (const msg of result.messages) {
							const contentItems = Array.isArray(msg.content) ? msg.content : [msg.content];
							for (const item of contentItems) {
								if (item.type === "text") {
									parts.push(item.text);
								} else if (item.type === "resource") {
									const resource = item.resource;
									if (resource.text) parts.push(resource.text);
								}
							}
						}
						return parts.join("\n\n");
					},
				},
			});
		}
	}
	return commands;
}
/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@oh-my-pi/pi-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   getApiKey: async () => Bun.env.MY_KEY,
 *   systemPrompt: 'You are helpful.',
 *   tools: codingTools({ cwd: getProjectDir() }),
 *   skills: [],
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
// === STARTUP-DBG (BUG: blank screen after migration prompt). Disable with SPELL_STARTUP_DBG=0. ===
const _dbgStartupT0_sdk = performance.now();
function dbgStartup(step: string, ctx?: Record<string, unknown>): void {
	if (process.env.SPELL_STARTUP_DBG !== "1") return;
	try {
		const elapsed = Math.round(performance.now() - _dbgStartupT0_sdk);
		const ctxStr = ctx ? " " + JSON.stringify(ctx) : "";
		process.stderr.write(`[STARTUP-DBG sdk +${elapsed}ms] ${step}${ctxStr}\n`);
		logger.info(`startup-dbg sdk: ${step}`, { ...(ctx ?? {}), elapsedMs: elapsed });
	} catch {}
}
// NOTE: inline timing — must NOT call logger.timeAsync/logger.time (those names were
// globally replaced with dbgTime* above, which would create infinite recursion).
function dbgTimeAsync<R, A extends unknown[]>(op: string, fn: (...args: A) => R, ...args: A): Promise<Awaited<R>> {
	dbgStartup(`phase:start:${op}`);
	const start = performance.now();
	return Promise.resolve(fn(...args)).then(
		r => {
			const ms = Math.round(performance.now() - start);
			logger.debug(`${op} done`, { duration: ms, op });
			dbgStartup(`phase:done:${op}`, { ms });
			return r as Awaited<R>;
		},
		e => {
			const ms = Math.round(performance.now() - start);
			dbgStartup(`phase:THREW:${op}`, { ms, error: e instanceof Error ? e.message : String(e) });
			throw e;
		},
	);
}
function dbgTime<T, A extends unknown[]>(op: string, fn: (...args: A) => T, ...args: A): T {
	dbgStartup(`phase:start:${op}`);
	const start = performance.now();
	try {
		const r = fn(...args);
		const ms = Math.round(performance.now() - start);
		logger.debug(`${op} done`, { duration: ms, op });
		dbgStartup(`phase:done:${op}`, { ms });
		return r;
	} catch (e) {
		const ms = Math.round(performance.now() - start);
		dbgStartup(`phase:THREW:${op}`, { ms, error: e instanceof Error ? e.message : String(e) });
		throw e;
	}
}

export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	dbgStartup("createAgentSession:enter");
	const cwd = options.cwd ?? getProjectDir();
	const agentDir = options.agentDir ?? getDefaultAgentDir();
	const eventBus = options.eventBus ?? new EventBus();

	registerSshCleanup();

	// Use provided or create AuthStorage and ModelRegistry
	const { authStorage, modelRegistry } = await dbgTimeAsync("discoverModels", async () => {
		const authStorage = options.authStorage ?? (await discoverAuthStorage(agentDir));
		const providerConfigs = await loadMergedProviderConfigs(cwd, agentDir);
		const modelRegistry = options.modelRegistry ?? new ModelRegistry(authStorage, providerConfigs);
		return { authStorage, modelRegistry };
	});
	const spellcastingWarning = await dbgTimeAsync("validateSpellcastingToken", () =>
		validateSpellcastingToken(authStorage),
	);
	const settings = await dbgTimeAsync(
		"settings",
		async () => options.settings ?? (await Settings.init({ cwd, agentDir })),
	);
	dbgTime("initializeWithSettings", initializeWithSettings, settings);
	if (!options.modelRegistry) {
		modelRegistry.refreshInBackground();
	}
	const skillsSettings = settings.getGroup("skills");
	const disabledExtensionIds = settings.get("disabledExtensions") ?? [];
	const discoveredSkillsPromise =
		options.skills === undefined
			? discoverSkills(cwd, agentDir, { ...skillsSettings, disabledExtensions: disabledExtensionIds })
			: undefined;

	// Initialize provider preferences from settings
	const webSearchProvider = settings.get("providers.webSearch");
	if (typeof webSearchProvider === "string" && isSearchProviderPreference(webSearchProvider)) {
		setPreferredSearchProvider(webSearchProvider);
	}

	const codeSearchProvider = settings.get("providers.codeSearch");
	if (typeof codeSearchProvider === "string" && isCodeSearchProviderId(codeSearchProvider)) {
		setPreferredCodeSearchProvider(codeSearchProvider);
	}

	const imageProvider = settings.get("providers.image");
	if (imageProvider === "auto" || imageProvider === "gemini" || imageProvider === "openrouter") {
		setPreferredImageProvider(imageProvider);
	}
	// providers.anthropicStreamIdleTimeoutMs removed in kdl-config cutover

	const sessionManager =
		options.sessionManager ??
		dbgTime("sessionManager", () =>
			SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir)),
		);
	const sessionId = sessionManager.getSessionId();
	const modelApiKeyAvailability = new Map<string, boolean>();
	const getModelAvailabilityKey = (candidate: Model): string =>
		`${candidate.provider}\u0000${candidate.baseUrl ?? ""}`;
	const hasModelApiKey = async (candidate: Model): Promise<boolean> => {
		const availabilityKey = getModelAvailabilityKey(candidate);
		const cached = modelApiKeyAvailability.get(availabilityKey);
		if (cached !== undefined) {
			return cached;
		}

		const hasKey = !!(await modelRegistry.getApiKey(candidate, sessionId));
		modelApiKeyAvailability.set(availabilityKey, hasKey);
		return hasKey;
	};

	// Check if session has existing data to restore
	const existingSession = dbgTime("loadSession", () => sessionManager.buildSessionContext());
	const hasExistingSession = existingSession.messages.length > 0;
	const hasThinkingEntry = sessionManager.getBranch().some(entry => entry.type === "thinking_level_change");

	const hasExplicitModel = options.model !== undefined || options.modelPattern !== undefined;
	const modelMatchPreferences = {
		usageOrder: settings.getStorage()?.getModelUsageOrder(),
	};
	const defaultRoleSpec = resolveModelRoleValue(settings.getModelRole("default"), modelRegistry.getAvailable(), {
		settings,
		matchPreferences: modelMatchPreferences,
	});
	let model = options.model;
	let modelFallbackMessage: string | undefined;
	// If session has data, try to restore model from it.
	// Skip restore when an explicit model was requested.
	const defaultModelStr = existingSession.models.default;
	if (!hasExplicitModel && !model && hasExistingSession && defaultModelStr) {
		const parsedModel = parseModelString(defaultModelStr);
		if (parsedModel) {
			const restoredModel = modelRegistry.find(parsedModel.provider, parsedModel.id);
			if (restoredModel && (await hasModelApiKey(restoredModel))) {
				model = restoredModel;
			}
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${defaultModelStr}`;
		}
	}

	// If still no model, try settings default.
	// Skip settings fallback when an explicit model was requested.
	if (!hasExplicitModel && !model && defaultRoleSpec.model) {
		if (await hasModelApiKey(defaultRoleSpec.model)) {
			model = defaultRoleSpec.model;
		}
	}

	const taskDepth = options.taskDepth ?? 0;

	let thinkingLevel = options.thinkingLevel;

	// If session has data and includes a thinking entry, restore it
	if (thinkingLevel === undefined && hasExistingSession && hasThinkingEntry) {
		thinkingLevel = parseThinkingLevel(existingSession.thinkingLevel);
	}

	if (thinkingLevel === undefined && !hasExplicitModel && !hasThinkingEntry && defaultRoleSpec.explicitThinkingLevel) {
		thinkingLevel = defaultRoleSpec.thinkingLevel;
	}

	// Fall back to settings default
	if (thinkingLevel === undefined) {
		thinkingLevel = settings.get("defaultThinkingLevel");
	}
	if (model) {
		thinkingLevel = resolveThinkingLevelForModel(model, thinkingLevel);
	}

	let skills: Skill[];
	let skillWarnings: SkillWarning[];
	if (options.skills !== undefined) {
		skills = options.skills;
		skillWarnings = [];
	} else {
		const discovered = await dbgTimeAsync("discoverSkills", async () =>
			discoveredSkillsPromise ? await discoveredSkillsPromise : { skills: [], warnings: [] },
		);
		skills = discovered.skills;
		skillWarnings = discovered.warnings;
	}

	// Discover rules
	const { ttsrManager, rulesResult, registeredTtsrRuleNames } = await dbgTimeAsync(
		"discoverTtsrRules",
		async () => {
			const ttsrSettings = settings.getGroup("ttsr");
			const ttsrManager = new TtsrManager(ttsrSettings);
			const rulesResult =
				options.rules !== undefined
					? { items: options.rules, warnings: undefined }
					: await loadCapability<Rule>(ruleCapability.id, { cwd });
			const registeredTtsrRuleNames = new Set<string>();
			for (const rule of rulesResult.items) {
				if (rule.condition && rule.condition.length > 0) {
					if (ttsrManager.addRule(rule)) {
						registeredTtsrRuleNames.add(rule.name);
					}
				}
			}
			if (existingSession.injectedTtsrRules.length > 0) {
				ttsrManager.restoreInjected(existingSession.injectedTtsrRules);
			}
			return { ttsrManager, rulesResult, registeredTtsrRuleNames };
		},
	);

	// Discover and resolve mode configs
	const modesResult = await dbgTimeAsync("discoverModes", async () => {
		const result = await loadCapability<ModeConfig>(modeConfigCapability.id, { cwd });
		const allModes = new Map(result.items.map(m => [m.name, m]));
		const resolvedConfigs = new Map<string, ResolvedModeConfig>();
		for (const mode of result.items) {
			try {
				resolvedConfigs.set(mode.name, resolveModeConfig(mode, allModes, new Map()));
			} catch (error) {
				result.warnings.push(`Mode "${mode.name}": ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return { resolvedConfigs, warnings: result.warnings };
	});

	// Filter rules for the rulebook (non-TTSR, non-alwaysApply, with descriptions)
	const rulebookRules = dbgTime("filterRulebookRules", () =>
		rulesResult.items.filter((rule: Rule) => {
			if (registeredTtsrRuleNames.has(rule.name)) return false;
			if (rule.alwaysApply) return false;
			if (!rule.description) return false;
			return true;
		}),
	);

	const domainPromptContext = await dbgTimeAsync("loadDomainPromptContext", () =>
		loadDomainPromptContext(options.domainManifest, cwd),
	);

	const baseContextFiles = await dbgTimeAsync(
		"discoverContextFiles",

		async () => options.contextFiles ?? (await discoverContextFiles(cwd, agentDir)),
	);

	const contextFiles = [...domainPromptContext.contextFiles, ...baseContextFiles];

	// Pre-compute system prompt preparation results for reuse across rebuilds.
	// AGENTS.md and SYSTEM.md are immutable for the session lifetime.
	const agentsMdSearchFallback = {
		scopePath: ".",
		limit: 200,
		pattern: "AGENTS.md depth 1-4",
		files: [],
	};
	const [prepAgentsMdSearch, prepSystemPromptCustomization] = await Promise.all([
		raceWithTimeout("AGENTS.md search", buildAgentsMdSearch(cwd), agentsMdSearchFallback, 5000),
		raceWithTimeout("SYSTEM.md loading", loadSystemPromptFiles({ cwd }), null, 5000),
	]);

	const spellcastDiscovery = await dbgTimeAsync("discoverSpellcastManifests", () =>
		discoverSpellcastManifests(cwd),
	);

	const spellcastPublishState = await dbgTimeAsync("loadSpellcastPublishState", () =>
		loadSpellcastPublishState(cwd),
	);

	const spellcastSessionContext: SpellcastSessionContext = {
		discovery: spellcastDiscovery,

		discoveredManifests: spellcastDiscovery.manifests,

		publishState: spellcastPublishState,
	};

	const spellcastReport = formatSpellcastSessionReport(spellcastSessionContext) || undefined;
	const hasExplicitToolNames = options.toolNames !== undefined;
	const requestedBuiltInToolNames = applyDomainToolPolicy(
		options.toolNames,
		Object.keys(BUILTIN_TOOLS),
		options.domainManifest,
	);

	let agent: Agent;
	let session: AgentSession;


	const asyncEnabled = settings.get("async.enabled");
	const asyncMaxJobs = Math.min(100, Math.max(1, settings.get("async.maxJobs") ?? 100));
	const asyncJobTimeoutMs = Math.max(0, settings.get("async.jobTimeoutMs") ?? 1_500_000);
	const ASYNC_INLINE_RESULT_MAX_CHARS = 12_000;
	const ASYNC_PREVIEW_MAX_CHARS = 4_000;
	const formatAsyncResultForFollowUp = async (result: string): Promise<string> => {
		if (result.length <= ASYNC_INLINE_RESULT_MAX_CHARS) {
			return result;
		}

		const preview = `${result.slice(0, ASYNC_PREVIEW_MAX_CHARS)}\n\n[Output truncated. Showing first ${ASYNC_PREVIEW_MAX_CHARS.toLocaleString()} characters.]`;
		try {
			const artifact = await sessionManager.allocateArtifactPath("async");
			if (artifact?.path) {
				await Bun.write(artifact.path, result);
				return `${preview}\nFull output: ${artifact.uri}`;
			}
		} catch (error) {
			logger.warn("Failed to persist async follow-up artifact", {
				error: error instanceof Error ? error.message : String(error),
			});
		}

		return preview;
	};
	const asyncJobManager = asyncEnabled
		? new AsyncJobManager({
				maxRunningJobs: asyncMaxJobs,
				jobTimeoutMs: asyncJobTimeoutMs,
				eventBus,
				onJobComplete: async (jobId, result, job) => {
					if (!session) return;
					const formattedResult = await formatAsyncResultForFollowUp(result);
					const message = renderPromptTemplate(asyncResultTemplate, { jobId, result: formattedResult });
					const durationMs = job ? Math.max(0, Date.now() - job.startTime) : undefined;
					await session.sendCustomMessage(
						{
							customType: "async-result",
							content: message,
							display: true,
							attribution: "agent",
							details: {
								jobId,
								type: job?.type,
								label: job?.label,
								durationMs,
							},
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				},
			})
		: undefined;

	const pendingActionStore = new PendingActionStore();

	const loopManager = new LoopManager({
		cwd,
		settings,
		eventBus,
		roleResolver: {
			getCurrentModel: () => session?.model ?? model,
			getPlanModel: () => session?.resolveRoleModel("plan"),
			getReviewModel: () => session?.resolveRoleModel("review"),
			getSettings: () => settings,
		},
	});

	const gatewayClient = taskDepth === 0 ? new GatewayClient({ autoSpawn: false }) : undefined;

	// Load project-level task policies once per session (cached in the closure below)
	const projectTaskPolicies = await loadTaskPolicies(cwd);

	const toolSession: ToolSession = {
		get cwd() {
			return sessionManager.getCwd();
		},
		hasUI: options.hasUI ?? false,

		sandboxPolicy: options.sandboxPolicy,
		hasEditTool: requestedBuiltInToolNames.includes("edit"),

		contextFiles,
		skills,
		eventBus,
		outputSchema: options.outputSchema,
		requireSubmitResultTool: options.requireSubmitResultTool,
		taskDepth: options.taskDepth ?? 0,
		getSessionFile: () => sessionManager.getSessionFile() ?? null,
		getSessionId: () => sessionManager.getSessionId?.() ?? null,
		getSystemPrompt: () => session.systemPrompt,
		getFirstUserMessage: () => session.getFirstUserMessage(),
		getSessionSpawns: () => options.spawns ?? "*",
		getModelString: () => (hasExplicitModel && model ? formatModelString(model) : undefined),
		getActiveModelString: () => {
			const activeModel = agent?.state.model;
			if (activeModel) return formatModelString(activeModel);
			// Fall back to initial model during tool creation (before agent exists)
			if (model) return formatModelString(model);
			return undefined;
		},
		getPlanModeState: () => session?.getPlanModeState(),
		getActiveModeState: () => session?.getActiveModeState(),
		isAgentIdle: () => !session.isStreaming,
		getCompactContext: () => session.formatCompactContext(),
		getTodoGroups: () => session.getTodoGroups(),
		setTodoGroups: (groups, options) => session.setTodoGroups(groups, options),
		isMCPDiscoveryEnabled: () => session.isMCPDiscoveryEnabled(),
		getDiscoverableMCPTools: () => session.getDiscoverableMCPTools(),
		getDiscoverableMCPSearchIndex: () => session.getDiscoverableMCPSearchIndex(),
		getSelectedMCPToolNames: () => session.getSelectedMCPToolNames(),
		activateDiscoveredMCPTools: toolNames => session.activateDiscoveredMCPTools(toolNames),
		getCheckpointState: () => session.getCheckpointState(),
		setCheckpointState: state => session.setCheckpointState(state ?? undefined),
		allocateOutputArtifact: async (toolType, extension) => {
			try {
				return await sessionManager.allocateArtifactPath(toolType, extension);
			} catch {
				return undefined;
			}
		},
		settings,
		authStorage,
		modelRegistry,
		asyncJobManager,
		pendingActionStore,
		loopManager,
		gatewayClient,
		getResolvedTaskPolicies: (() => {
			let cached: TaskPolicy[] | undefined;
			return () => {
				if (cached !== undefined) return cached;
				const modeState = session?.getActiveModeState();
				let modePolicies: TaskPolicy[] | undefined;
				if (modeState?.type === "plan" && modeState.modeConfigName) {
					modePolicies = session?.getModeConfig(modeState.modeConfigName)?.frontmatter?.taskPolicies;
				} else if (modeState?.type === "user") {
					modePolicies = modeState.config?.frontmatter?.taskPolicies;
				}
				cached = mergePolicies(projectTaskPolicies, modePolicies).policies;
				return cached;
			};
		})(),
		getBashHistory: () => session.getBashHistory(),
		captureGitBaseline: () => session.captureGitBaseline(),
		compareGitBaseline: baseline => session.compareGitBaseline(baseline),
	};

	// Initialize internal URL router for internal protocols (agent://, artifact://, memory://, skill://, rule://, mcp://, local://, task://, data://)
	const internalRouter = new InternalUrlRouter();
	const getArtifactsDir = () => sessionManager.getArtifactsDir();
	internalRouter.register(new AgentProtocolHandler({ getArtifactsDir }));
	// PLAN-310 BUG-396: artifact:// is kernel-owned via Indexed loader
	// (UserRoot + mtime-cached cross-session scan).
	internalRouter.register(
		new MemoryProtocolHandler({
			getMemoryRoot: () => getMemoryRoot(agentDir, settings.getCwd()),
		}),
	);
	internalRouter.register(
		new LocalProtocolHandler({
			getArtifactsDir,
			getSessionId: () => sessionManager.getSessionId(),
		}),
	);
	internalRouter.register(new PiProtocolHandler());

	// PLAN-310 BUG-393/394/395: rule, skill, jobs are kernel-owned via dynamic
	// callback registration. registerScheme bridges the kernel SchemeRegistry
	// back to this process's in-memory state (session.rules, session.skills,
	// asyncJobManager) via the JsTsfnCallback bridge.
	const callbackSchemeErrors = setupCallbackSchemes({
		getRules:            () => rulebookRules as readonly Rule[],
		getSkills:           () => skills as readonly Skill[],
		getAsyncJobManager:  () => asyncJobManager,
	});
	for (const e of callbackSchemeErrors) {
		logger.warn(`URI scheme '${e.scheme}' registration failed: ${e.reason}`);
	}
	internalRouter.register(new McpProtocolHandler({ getMcpManager: () => mcpManager }));
	for (const handler of createTaskUriProtocolHandlers({ getCurrentSessionId: () => sessionManager.getSessionId() })) {
		internalRouter.register(handler);
	}
	internalRouter.register(
		new OrgProtocolHandler({
			getSettings: () => settings,
			getCwd: () => sessionManager.getCwd(),
		}),
	);
	internalRouter.register(
		new CanvasProtocolHandler({
			getStdlibRoot: () => path.resolve(import.meta.dir, "modes/qml"),
			getArtifactsDir,
			getSessionId: () => sessionManager.getSessionId(),
		}),
	);
	toolSession.internalRouter = internalRouter;
	toolSession.getArtifactsDir = getArtifactsDir;
	toolSession.agentOutputManager = new AgentOutputManager(
		getArtifactsDir,
		options.parentTaskPrefix ? { parentPrefix: options.parentTaskPrefix } : undefined,
	);

	// Create built-in tools (already wrapped with meta notice formatting)
	const builtinTools = await dbgTimeAsync("createAllTools", () =>
		createTools(toolSession, requestedBuiltInToolNames),
	);

	// Discover MCP tools from .mcp.json files
	let mcpManager: MCPManager | undefined;
	const enableMCP = options.enableMCP ?? true;
	const customTools: CustomTool[] = [];
	if (enableMCP) {
		const mcpResult = await dbgTimeAsync("discoverAndLoadMCPTools", () =>
			discoverAndLoadMCPTools(cwd, {
				onConnecting: serverNames => {
					if (options.hasUI && serverNames.length > 0) {
						process.stderr.write(`${chalk.gray(`Connecting to MCP servers: ${serverNames.join(", ")}…`)}\n`);
					}
				},
				enableProjectConfig: settings.get("mcp.enableProjectConfig") ?? true,
				// Always filter Exa - we have native integration
				filterExa: true,
				// Filter browser MCP servers when builtin browser tool is active
				filterBrowser: settings.get("browser.enabled") ?? false,
				cacheStorage: settings.getStorage(),
				authStorage,
			}),
		);
		mcpManager = mcpResult.manager;
		toolSession.mcpManager = mcpManager;

		if (settings.get("mcp.notifications")) {
			mcpManager.setNotificationsEnabled(true);
		}
		// If we extracted Exa API keys from MCP configs and EXA_API_KEY isn't set, use the first one
		if (mcpResult.exaApiKeys.length > 0 && !$env.EXA_API_KEY) {
			Bun.env.EXA_API_KEY = mcpResult.exaApiKeys[0];
		}

		// Log MCP errors
		for (const { path, error } of mcpResult.errors) {
			logger.error("MCP tool load failed", { path, error });
		}

		if (mcpResult.tools.length > 0) {
			// MCP tools are LoadedCustomTool, extract the tool property
			customTools.push(...mcpResult.tools.map(loaded => loaded.tool));
		}
	}

	// Add Gemini image tools if GEMINI_API_KEY (or GOOGLE_API_KEY) is available
	const geminiImageTools = await dbgTimeAsync("getGeminiImageTools", getGeminiImageTools);
	if (geminiImageTools.length > 0) {
		customTools.push(...(geminiImageTools as unknown as CustomTool[]));
	}

	// Add web search tools
	customTools.push(...getSearchTools());

	// Discover and load custom tools from .spell/tools/, .claude/tools/, etc.
	const builtInToolNames = builtinTools.map(t => t.name);
	const discoveredCustomTools = await dbgTimeAsync(
		"discoverAndLoadCustomTools",
		discoverAndLoadCustomTools,
		[],
		cwd,
		builtInToolNames,
		pendingActionStore,
	);
	for (const { path, error } of discoveredCustomTools.errors) {
		logger.error("Custom tool load failed", { path, error });
	}
	if (discoveredCustomTools.tools.length > 0) {
		customTools.push(...discoveredCustomTools.tools.map(loaded => loaded.tool));
	}

	const inlineExtensions: ExtensionFactory[] = options.extensions ? [...options.extensions] : [];
	inlineExtensions.push(createCavemanExtension(settings));
	if (customTools.length > 0) {
		inlineExtensions.push(createCustomToolsExtension(customTools));
	}

	// Load extensions (discovers from standard locations + configured paths)
	let extensionsResult: LoadExtensionsResult;
	if (options.disableExtensionDiscovery) {
		const configuredPaths = options.additionalExtensionPaths ?? [];
		extensionsResult = await dbgTimeAsync("loadExtensions", loadExtensions, configuredPaths, cwd, eventBus);
		for (const { path, error } of extensionsResult.errors) {
			logger.error("Failed to load extension", { path, error });
		}
	} else if (options.preloadedExtensions) {
		extensionsResult = options.preloadedExtensions;
	} else {
		// Merge CLI extension paths with settings extension paths
		const configuredPaths = [...(options.additionalExtensionPaths ?? []), ...(settings.get("extensions") ?? [])];
		const disabledExtensionIds = settings.get("disabledExtensions") ?? [];
		extensionsResult = await dbgTimeAsync(
			"discoverAndLoadExtensions",
			discoverAndLoadExtensions,
			configuredPaths,
			cwd,
			eventBus,
			disabledExtensionIds,
		);
		for (const { path, error } of extensionsResult.errors) {
			logger.error("Failed to load extension", { path, error });
		}
	}

	// Load inline extensions from factories
	if (inlineExtensions.length > 0) {
		for (let i = 0; i < inlineExtensions.length; i++) {
			const factory = inlineExtensions[i];
			const loaded = await loadExtensionFromFactory(
				factory,
				cwd,
				eventBus,
				extensionsResult.runtime,
				`<inline-${i}>`,
			);
			extensionsResult.extensions.push(loaded);
		}
	}

	// Process provider registrations queued during extension loading.
	// This must happen before the runner is created so that models registered by
	// extensions are available for model selection on session resume / fallback.
	const activeExtensionSources = extensionsResult.extensions.map(extension => extension.path);
	modelRegistry.syncExtensionSources(activeExtensionSources);
	for (const sourceId of new Set(activeExtensionSources)) {
		modelRegistry.clearSourceRegistrations(sourceId);
	}
	if (extensionsResult.runtime.pendingProviderRegistrations.length > 0) {
		for (const { name, config, sourceId } of extensionsResult.runtime.pendingProviderRegistrations) {
			modelRegistry.registerProvider(name, config, sourceId);
		}
		extensionsResult.runtime.pendingProviderRegistrations = [];
	}

	// Resolve deferred --model pattern now that extension models are registered.
	if (!model && options.modelPattern) {
		const availableModels = modelRegistry.getAll();
		const matchPreferences = {
			usageOrder: settings.getStorage()?.getModelUsageOrder(),
		};
		const { model: resolved } = parseModelPattern(options.modelPattern, availableModels, matchPreferences);
		if (resolved) {
			model = resolved;
			modelFallbackMessage = undefined;
		} else {
			modelFallbackMessage = `Model "${options.modelPattern}" not found`;
		}
	}

	// Fall back to first available model with a valid API key.
	// Skip fallback if the user explicitly requested a model via --model that wasn't found.
	if (!model && !options.modelPattern) {
		const allModels = modelRegistry.getAll();
		for (const candidate of allModels) {
			if (await hasModelApiKey(candidate)) {
				model = candidate;
				break;
			}
		}
		if (model) {
			if (modelFallbackMessage) {
				modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
			}
		} else {
			modelFallbackMessage =
				"No models available. Use /login or set an API key environment variable. Then use /model to select a model.";
		}
	}

	// Discover custom commands (TypeScript slash commands)
	const customCommandsResult: CustomCommandsLoadResult = options.disableExtensionDiscovery
		? { commands: [], errors: [] }
		: await dbgTimeAsync("discoverCustomCommands", loadCustomCommandsInternal, { cwd, agentDir });
	if (!options.disableExtensionDiscovery) {
		for (const { path, error } of customCommandsResult.errors) {
			logger.error("Failed to load custom command", { path, error });
		}
	}

	let extensionRunner: ExtensionRunner | undefined;
	if (extensionsResult.extensions.length > 0) {
		extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			cwd,
			sessionManager,
			modelRegistry,
		);
	}

	const getSessionContext = () => ({
		sessionManager,
		modelRegistry,
		model: agent.state.model,
		isIdle: () => !session.isStreaming,
		hasQueuedMessages: () => session.queuedMessageCount > 0,
		abort: () => {
			session.abort();
		},
		settings,
	});
	const toolContextStore = new ToolContextStore(getSessionContext);

	const registeredTools = extensionRunner?.getAllRegisteredTools() ?? [];
	let wrappedExtensionTools: Tool[];

	if (extensionRunner) {
		// With extension runner: convert CustomTools to ToolDefinitions and wrap all together
		const allCustomTools = [
			...registeredTools,
			...(options.customTools?.map(tool => {
				const definition = isCustomTool(tool) ? customToolToDefinition(tool) : tool;
				return { definition, extensionPath: "<sdk>" };
			}) ?? []),
		];
		wrappedExtensionTools = wrapRegisteredTools(allCustomTools, extensionRunner);
	} else {
		// Without extension runner: wrap CustomTools directly with CustomToolAdapter
		// ToolDefinition items require ExtensionContext and cannot be used without a runner
		const customToolContext = (): CustomToolContext => ({
			sessionManager,
			modelRegistry,
			model: agent?.state.model,
			isIdle: () => !session?.isStreaming,
			hasQueuedMessages: () => (session?.queuedMessageCount ?? 0) > 0,
			abort: () => session?.abort(),
			settings,
		});
		wrappedExtensionTools = (options.customTools ?? [])
			.filter(isCustomTool)
			.map(tool => CustomToolAdapter.wrap(tool, customToolContext));
	}

	// All built-in tools are active (conditional tools like git/ask return null from factory if disabled)
	const toolRegistry = new Map<string, Tool>();
	for (const tool of builtinTools) {
		toolRegistry.set(tool.name, tool);
	}
	for (const tool of wrappedExtensionTools) {
		toolRegistry.set(tool.name, tool);
	}
	if (extensionRunner) {
		for (const tool of toolRegistry.values()) {
			toolRegistry.set(tool.name, new ExtensionToolWrapper(tool, extensionRunner));
		}
	}
	if (model?.provider === "cursor") {
		toolRegistry.delete("edit");
	}

	const hasDeferrableTools = Array.from(toolRegistry.values()).some(tool => tool.deferrable === true);
	if (!hasDeferrableTools) {
		toolRegistry.delete("resolve");
	} else if (!toolRegistry.has("resolve")) {
		const resolveTool = await dbgTimeAsync("createTools:resolve:session", HIDDEN_TOOLS.resolve, toolSession);
		if (resolveTool) {
			toolRegistry.set(resolveTool.name, wrapToolWithMetaNotice(resolveTool));
		}
	}

	let cursorEventEmitter: ((event: AgentEvent) => void) | undefined;
	const cursorExecHandlers = new CursorExecHandlers({
		cwd,
		tools: toolRegistry,
		getToolContext: () => toolContextStore.getContext(),
		emitEvent: event => cursorEventEmitter?.(event),
	});

	const repeatToolDescriptions = settings.get("repeatToolDescriptions");
	const eagerTasks = settings.get("task.eager");
	const intentField = settings.get("tools.intentTracing") || $env.PI_INTENT_TRACING === "1" ? INTENT_FIELD : undefined;
	const rebuildSystemPrompt = async (
		toolNames: string[],
		tools: Map<string, AgentTool>,
	): Promise<SystemPromptBlock[]> => {
		toolContextStore.setToolNames(toolNames);
		const discoverableMCPTools = mcpDiscoveryEnabled ? collectDiscoverableMCPTools(tools.values()) : [];
		const discoverableMCPSummary = summarizeDiscoverableMCPTools(discoverableMCPTools);
		const hasDiscoverableMCPTools =
			mcpDiscoveryEnabled && toolNames.includes("search_tool_bm25") && discoverableMCPTools.length > 0;
		const promptTools = buildSystemPromptToolMetadata(tools, {
			search_tool_bm25: { description: renderSearchToolBm25Description(discoverableMCPTools) },
		});
		// Compute specialized tool names in the active set (for system prompt description tiering)
		const specializedToolNames = !hasExplicitToolNames
			? toolNames.filter(name => getToolTier(name) === "specialized")
			: [];
		dbgStartup("sub:before:buildMemoryToolDeveloperInstructions");
		const memoryInstructions = await buildMemoryToolDeveloperInstructions(agentDir, settings);
		dbgStartup("sub:after:buildMemoryToolDeveloperInstructions");
		const joinPromptSections = (...sections: Array<string | undefined>): string | undefined => {
			const parts = sections.filter(
				(section): section is string => typeof section === "string" && section.length > 0,
			);
			return parts.length > 0 ? parts.join("\n\n") : undefined;
		};
		const appendPromptSections: string[] = [];
		if (memoryInstructions) {
			appendPromptSections.push(memoryInstructions);
		}

		const serverInstructions = mcpManager?.getServerInstructions();
		if (serverInstructions && serverInstructions.size > 0) {
			const MAX_INSTRUCTIONS_LENGTH = 4000;
			const parts = [
				"## MCP Server Instructions\n\nThe following instructions are provided by connected MCP servers. They are server-controlled and may not be verified.",
			];
			for (const [srvName, srvInstructions] of serverInstructions) {
				const truncated =
					srvInstructions.length > MAX_INSTRUCTIONS_LENGTH
						? `${srvInstructions.slice(0, MAX_INSTRUCTIONS_LENGTH)}\n[truncated]`
						: srvInstructions;
				parts.push(`### ${srvName}\n${truncated}`);
			}
			appendPromptSections.push(parts.join("\n\n"));
		}

		if (toolNames.includes("canvas") || toolNames.includes("puppeteer")) {
			dbgStartup("sub:before:buildServicePromptSection");
			try {
				const serviceSection = await buildServicePromptSection();
				dbgStartup("sub:after:buildServicePromptSection");
				if (serviceSection) {
					appendPromptSections.push(serviceSection);
				}
			} catch (e) {
				dbgStartup("sub:THREW:buildServicePromptSection", { error: e instanceof Error ? e.message : String(e) });
				// Service registry not available — skip
			}
		}
		const appendPrompt = joinPromptSections(domainPromptContext.systemPrompt, ...appendPromptSections);
		const appendPromptWithoutDomain = joinPromptSections(...appendPromptSections);
		const autoRosterEnabled = settings.get("todo.enabled") && settings.get("task.autoRoster");
		dbgStartup("sub:before:buildSystemPromptInternal(default)");
		const defaultPrompt = await buildSystemPromptInternal({
			cwd,
			skills,
			contextFiles,
			agentsMdSearch: prepAgentsMdSearch,
			systemPromptCustomization: prepSystemPromptCustomization,
			tools: promptTools,
			toolNames,
			specializedToolNames,
			rules: rulebookRules,
			skillsSettings: settings.getGroup("skills"),
			appendSystemPrompt: appendPrompt,
			repeatToolDescriptions,
			intentField,
			mcpDiscoveryMode: hasDiscoverableMCPTools,
			mcpDiscoveryServerSummaries: discoverableMCPSummary.servers.map(formatDiscoverableMCPToolServerSummary),
			eagerTasks,
			autoRosterEnabled,
			settings,
			isSubagent: taskDepth > 0,
		});
		dbgStartup("sub:after:buildSystemPromptInternal(default)");

		if (options.systemPrompt === undefined) {
			return defaultPrompt;
		}
		if (typeof options.systemPrompt === "string") {
			const customPrompt = domainPromptContext.systemPrompt
				? `${domainPromptContext.systemPrompt}\n\n${options.systemPrompt}`
				: options.systemPrompt;
			return await buildSystemPromptInternal({
				cwd,
				skills,
				contextFiles,
				agentsMdSearch: prepAgentsMdSearch,
				systemPromptCustomization: prepSystemPromptCustomization,
				tools: promptTools,
				toolNames,
				specializedToolNames,
				rules: rulebookRules,
				skillsSettings: settings.getGroup("skills"),
				customPrompt,
				appendSystemPrompt: appendPromptWithoutDomain,
				repeatToolDescriptions,
				intentField,
				mcpDiscoveryMode: hasDiscoverableMCPTools,
				mcpDiscoveryServerSummaries: discoverableMCPSummary.servers.map(formatDiscoverableMCPToolServerSummary),
				eagerTasks,
				autoRosterEnabled,
				settings,
				isSubagent: taskDepth > 0,
			});
		}
		const result = options.systemPrompt(defaultPrompt);
		if (typeof result === "string") {
			return [{ text: result, stable: true }];
		}
		return result;
	};

	const toolNamesFromRegistry = Array.from(toolRegistry.keys());
	const requestedToolNames = applyDomainToolPolicy(
		hasExplicitToolNames ? options.toolNames : undefined,
		toolNamesFromRegistry,
		options.domainManifest,
	);
	if (
		options.requireSubmitResultTool &&
		toolRegistry.has("submit_result") &&
		!requestedToolNames.includes("submit_result")
	) {
		requestedToolNames.push("submit_result");
	}
	const normalizedRequested = requestedToolNames.filter(name => toolRegistry.has(name));
	const includeExitPlanMode = requestedToolNames.includes("exit_plan_mode");
	const mcpDiscoveryEnabled = settings.get("mcp.discoveryMode") ?? false;
	const requestedActiveToolNames = includeExitPlanMode
		? normalizedRequested
		: normalizedRequested.filter(name => name !== "exit_plan_mode");
	const explicitlyRequestedMCPToolNames = hasExplicitToolNames
		? requestedActiveToolNames.filter(name => name.startsWith("mcp_"))
		: [];
	const initialToolNames = mcpDiscoveryEnabled
		? [...requestedActiveToolNames.filter(name => !name.startsWith("mcp_")), ...explicitlyRequestedMCPToolNames]
		: [...requestedActiveToolNames];
	// All tools stay in the active set — tiering controls description verbosity, not availability.
	const initialSelectedMCPToolNames = mcpDiscoveryEnabled ? [...explicitlyRequestedMCPToolNames] : [];

	// Custom tools and extension-registered tools are always included regardless of toolNames filter
	const alwaysInclude: string[] = [
		...(options.customTools?.map(t => (isCustomTool(t) ? t.name : t.name)) ?? []),
		...registeredTools.map(t => t.definition.name),
	];
	for (const name of alwaysInclude) {
		if (mcpDiscoveryEnabled && name.startsWith("mcp_")) {
			continue;
		}
		if (toolRegistry.has(name) && !initialToolNames.includes(name)) {
			initialToolNames.push(name);
		}
	}

	const systemPrompt = await dbgTimeAsync(
		"buildSystemPrompt",
		rebuildSystemPrompt,
		initialToolNames,
		toolRegistry,
	);

	const promptTemplates =
		options.promptTemplates ??
		(await dbgTimeAsync("discoverPromptTemplates", discoverPromptTemplates, cwd, agentDir));
	toolSession.promptTemplates = promptTemplates;

	const slashCommands =
		options.slashCommands ?? (await dbgTimeAsync("discoverSlashCommands", discoverSlashCommands, cwd));

	// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		const converted = convertToLlm(messages);
		// Check setting dynamically so mid-session changes take effect
		if (!settings.get("images.blockImages")) {
			return converted;
		}
		// Filter out ImageContent from all messages, replacing with text placeholder
		return converted.map(msg => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some(c => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map(c => (c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c))
							.filter((c, i, arr) => {
								// Dedupe consecutive "Image reading is disabled." texts
								if (!(c.type === "text" && c.text === "Image reading is disabled." && i > 0)) return true;
								const prev = arr[i - 1];
								return !(prev.type === "text" && prev.text === "Image reading is disabled.");
							});
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};

	// Load and create secret obfuscator if secrets are enabled
	let obfuscator: SecretObfuscator | undefined;
	if (settings.get("secrets.enabled")) {
		const fileEntries = await dbgTimeAsync("loadSecrets", loadSecrets, cwd, agentDir);
		const envEntries = collectEnvSecrets();
		const allEntries = [...envEntries, ...fileEntries];
		if (allEntries.length > 0) {
			obfuscator = new SecretObfuscator(allEntries);
		}
	}

	// Final convertToLlm: chain block-images filter with secret obfuscation
	const convertToLlmFinal = (messages: AgentMessage[]): Message[] => {
		const converted = convertToLlmWithBlockImages(messages);
		if (!obfuscator?.hasSecrets()) return converted;
		return obfuscateMessages(obfuscator, converted);
	};
	const transformContext = extensionRunner
		? async (messages: AgentMessage[], _signal?: AbortSignal) => {
				return await extensionRunner.emitContext(messages);
			}
		: undefined;
	const onPayload = extensionRunner
		? async (payload: unknown, _model?: Model) => {
				return await extensionRunner.emitBeforeProviderRequest(payload);
			}
		: undefined;

	const setToolUIContext = (uiContext: ExtensionUIContext, hasUI: boolean) => {
		toolContextStore.setUIContext(uiContext, hasUI);
	};

	// Build initial tool set: specialized tools get compact descriptions to reduce API token usage.
	// Clone preserves prototype (execute method) + copies own props (name, parameters) + overrides description.
	const initialTools = initialToolNames
		.map(name => {
			const tool = toolRegistry.get(name);
			if (!tool) return null;
			if (!hasExplicitToolNames && getToolTier(name) === "specialized" && tool.description) {
				const compact = compactToolDescription(tool.description);
				return Object.assign(Object.create(Object.getPrototypeOf(tool)), tool, {
					description: compact,
				}) as AgentTool;
			}
			return tool;
		})
		.filter((tool): tool is AgentTool => tool !== null);

	const openaiWebsocketSetting = settings.get("providers.openaiWebsockets") ?? "auto";
	const preferOpenAICodexWebsockets =
		openaiWebsocketSetting === "on" ? true : openaiWebsocketSetting === "off" ? false : undefined;
	const serviceTierSetting = settings.get("serviceTier");

	agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			thinkingLevel: toReasoningEffort(thinkingLevel),
			tools: initialTools,
		},
		convertToLlm: convertToLlmFinal,
		onPayload,
		sessionId: sessionManager.getSessionId(),
		transformContext,
		steeringMode: settings.get("steeringMode") ?? "one-at-a-time",
		followUpMode: settings.get("followUpMode") ?? "one-at-a-time",
		interruptMode: settings.get("interruptMode") ?? "immediate",
		thinkingBudgets: settings.getGroup("thinkingBudgets"),
		temperature: settings.get("temperature") >= 0 ? settings.get("temperature") : undefined,
		topP: settings.get("topP") >= 0 ? settings.get("topP") : undefined,
		topK: settings.get("topK") >= 0 ? settings.get("topK") : undefined,
		minP: settings.get("minP") >= 0 ? settings.get("minP") : undefined,
		presencePenalty: settings.get("presencePenalty") >= 0 ? settings.get("presencePenalty") : undefined,
		repetitionPenalty: settings.get("repetitionPenalty") >= 0 ? settings.get("repetitionPenalty") : undefined,
		serviceTier: serviceTierSetting === "none" ? undefined : serviceTierSetting,
		kimiApiFormat: settings.get("providers.kimiApiFormat") ?? "anthropic",
		preferWebsockets: preferOpenAICodexWebsockets,
		getToolContext: tc => toolContextStore.getContext(tc),
		getApiKey: async provider => {
			// Use the provider argument from the in-flight request;
			// agent.state.model may already be switched mid-turn.
			const key = await modelRegistry.getApiKeyForProvider(provider, sessionId);
			if (!key) {
				throw new Error(`No API key found for provider "${provider}"`);
			}
			return key;
		},
		cursorExecHandlers,
		transformToolCallArguments: (args, _toolName) => {
			let result = args;
			const maxTimeout = settings.get("tools.maxTimeout");
			if (maxTimeout > 0 && typeof result.timeout === "number") {
				result = { ...result, timeout: Math.min(result.timeout, maxTimeout) };
			}
			if (obfuscator?.hasSecrets()) {
				result = obfuscator.deobfuscateObject(result);
			}
			return result;
		},
		intentTracing: !!intentField,
		getToolChoice: () => {
			if (pendingActionStore.hasPending) {
				return { type: "function", name: "resolve" };
			}
			return session?.consumeNextToolChoiceOverride();
		},
		// Resolve tools in the registry but not in the active set (e.g., MCP tools added mid-session)
		resolveUnknownTool: async (toolName: string) => {
			const tool = toolRegistry.get(toolName);
			if (!tool) return null;
			const currentActiveNames = session?.getActiveToolNames() ?? [];
			if (!currentActiveNames.includes(toolName)) {
				await session?.setActiveToolsByName([...currentActiveNames, toolName]);
				logger.debug("Auto-activated tool from registry", { toolName });
			}
			// Return the tool from the agent's active set (compact-wrapped) rather than
			// the raw registry entry, so the tool used this turn matches the agent state.
			const activeTool = session?.agent.state.tools.find(t => t.name === toolName);
			return activeTool ?? tool;
		},
	});
	cursorEventEmitter = event => agent.emitExternalEvent(event);

	// Restore messages if session has existing data
	if (hasExistingSession) {
		agent.replaceMessages(existingSession.messages);
		if (!hasThinkingEntry) {
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
	} else {
		// Save initial model and thinking level for new sessions so they can be restored on resume
		if (model) {
			sessionManager.appendModelChange(`${model.provider}/${model.id}`);
		}
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	session = new AgentSession({
		agent,
		thinkingLevel,
		sessionManager,
		settings,
		scopedModels: options.scopedModels,
		promptTemplates,
		slashCommands,
		extensionRunner,
		customCommands: customCommandsResult.commands,
		skills,
		skillWarnings,
		skillsSettings: settings.getGroup("skills"),
		modelRegistry,
		toolRegistry,
		transformContext,
		onPayload,
		convertToLlm: convertToLlmFinal,
		rebuildSystemPrompt,
		mcpDiscoveryEnabled,
		initialSelectedMCPToolNames,
		ttsrManager,
		obfuscator,
		asyncJobManager,
		pendingActionStore,
		toolSession,
		loopManager,
		taskDepth,
	});

	if (modesResult.resolvedConfigs.size > 0) {
		session.setModeConfigs(modesResult.resolvedConfigs);
	}
	for (const warning of modesResult.warnings) {
		logger.warn(warning);
	}
	await loopManager.restoreFromDisk();

	postmortem.registerSessionContext(() => {
		const activeModel = session.model ?? model;
		return {
			session: {
				id: sessionManager.getSessionId(),
				file: sessionManager.getSessionFile() ?? null,
				cwd: sessionManager.getCwd(),
			},
			model: activeModel
				? {
						provider: activeModel.provider,
						id: activeModel.id,
						key: formatModelString(activeModel),
					}
				: null,
		};
	});

	if (model?.api === "openai-codex-responses") {
		try {
			await dbgTimeAsync("prewarmCodexWebsocket", prewarmOpenAICodexResponses, model, {
				apiKey: await modelRegistry.getApiKey(model, sessionId),
				sessionId,
				preferWebsockets: preferOpenAICodexWebsockets,
				providerSessionState: session.providerSessionState,
			});
		} catch (error) {
			logger.debug("Codex websocket prewarm failed", {
				error: error instanceof Error ? error.message : String(error),
				provider: model.provider,
				model: model.id,
			});
		}
	}

	// Warm up LSP servers (connects to detected servers)
	// LSP servers are warmed up in background — don't block session creation.
	// Tools use lazy getOrCreateClient, so they work before warmup completes.


	toolSession.dispose = async () => {
		if (toolSession.qmlRemoteServer) {
			try {
				toolSession.qmlRemoteServer.stop();
			} catch (err) {
				logger.warn("qmlRemoteServer stop failed", { error: String(err) });
			}
		}
	};
	startMemoryStartupTask({
		session,
		settings,
		modelRegistry,
		agentDir,
		taskDepth,
		onPhase1Complete: stats => {
			if (stats) {
				logger.debug("Memory phase1 usage", stats.usage);
			}
		},
	});

	// Wire MCP manager callbacks to session for reactive tool updates
	if (mcpManager) {
		mcpManager.setOnToolsChanged(tools => {
			void session.refreshMCPTools(tools);
		});
		// Wire prompt refresh → rebuild MCP prompt slash commands
		mcpManager.setOnPromptsChanged(serverName => {
			const promptCommands = buildMCPPromptCommands(mcpManager);
			session.setMCPPromptCommands(promptCommands);
			logger.debug("MCP prompt commands refreshed", { path: `mcp:${serverName}` });
		});
		const notificationDebounceTimers = new Map<string, Timer>();
		const clearDebounceTimers = () => {
			for (const timer of notificationDebounceTimers.values()) clearTimeout(timer);
			notificationDebounceTimers.clear();
		};
		postmortem.register("mcp-notification-cleanup", clearDebounceTimers);
		mcpManager.setOnResourcesChanged((serverName, uri) => {
			logger.debug("MCP resources changed", { path: `mcp:${serverName}`, uri });
			if (!settings.get("mcp.notifications")) return;
			const debounceMs = settings.get("mcp.notificationDebounceMs");
			const key = `${serverName}:${uri}`;
			const existing = notificationDebounceTimers.get(key);
			if (existing) clearTimeout(existing);
			notificationDebounceTimers.set(
				key,
				setTimeout(() => {
					notificationDebounceTimers.delete(key);
					// Re-check: user may have disabled notifications during the debounce window
					if (!settings.get("mcp.notifications")) return;
					void session.followUp(
						`[MCP notification] Server "${serverName}" reports resource \`${uri}\` was updated. Use read(path="mcp://${uri}") to inspect if relevant.`,
					);
				}, debounceMs),
			);
		});
	}

	// Wire QML event loop follow-ups: events from background loops arrive as automatic follow-up turns.
	eventBus.subscribe(CANVAS_EVENTS_CHANNEL, async (raw: unknown) => {
		if (!session) return;
		const { windowId, events, closed, silent, silentSummary } = raw as CanvasWindowEventsPayload;
		if (events.length === 0 && !closed) return;

		if (silent) {
			// Silent events: record in transcript for debugging but don't trigger a turn.
			const lines: string[] = [`${events.length} silent event(s) from canvas window '${windowId}':`];
			for (const e of events) {
				lines.push(JSON.stringify(e.payload));
			}
			await session.sendCustomMessage({
				customType: "canvas-events",
				content: lines.join("\n"),
				display: false,
				attribution: "agent",
				details: { windowId, events, closed },
			});
			return;
		}

		const lines: string[] = [];
		if (silentSummary) lines.push(silentSummary);
		lines.push(`${events.length} event(s) from canvas window '${windowId}'${closed ? " [closed]" : ""}:`);
		for (const e of events) {
			lines.push(JSON.stringify(e.payload));
		}
		await session.sendCustomMessage(
			{
				customType: "canvas-events",
				content: lines.join("\n"),
				display: true,
				attribution: "agent",
				details: { windowId, events, closed },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});

	const tryCanvasTidewaveFallback = async (
		tool: string,
		args: Record<string, unknown>,
	): Promise<AgentToolResult<unknown> | null> => {
		const tidewaveToolName =
			tool === "mcp_tidewave_get_source_location"
				? "get_source_location"
				: tool === "mcp_tidewave_get_docs"
					? "get_docs"
					: null;
		if (!tidewaveToolName) return null;
		const reference = typeof args.reference === "string" ? args.reference.trim() : "";
		if (!reference) {
			throw new Error("Tidewave request is missing reference");
		}
		const mcpUrl =
			typeof args.mcpUrl === "string" && args.mcpUrl.trim().length > 0
				? args.mcpUrl.trim()
				: "http://localhost:4000/tidewave/mcp";
		const response = await fetch(mcpUrl, {
			method: "POST",
			headers: {
				Accept: "application/json, text/event-stream",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: Date.now(),
				method: "tools/call",
				params: { name: tidewaveToolName, arguments: { reference } },
			}),
		});
		if (!response.ok) {
			throw new Error(`Tidewave ${tidewaveToolName} failed with ${response.status} ${response.statusText}`);
		}
		const payload = (await response.json()) as {
			error?: { message?: unknown };
			result?: { content?: Array<{ type?: unknown; text?: unknown }> };
		};
		if (payload.error && typeof payload.error.message === "string" && payload.error.message.trim().length > 0) {
			throw new Error(payload.error.message.trim());
		}
		const text = (payload.result?.content ?? [])
			.filter(block => block && block.type === "text" && typeof block.text === "string")
			.map(block => String(block.text).trim())
			.filter(Boolean)
			.join("\n\n");
		if (!text) {
			throw new Error("Tidewave returned no text content.");
		}
		return { content: [{ type: "text", text }], details: { fallback: "tidewave-http", mcpUrl } };
	};

	// Wire QML armed tool invocations: short-circuit tool execution without an agent turn.
	eventBus.subscribe(CANVAS_TOOL_INVOKE_CHANNEL, async (raw: unknown) => {
		if (!session) return;
		const { windowId, tool, args, allowedTools, reply } = raw as CanvasToolInvokePayload;

		// Validate against the per-window allowlist declared at launch time.
		if (!allowedTools.includes(tool)) {
			const errMsg = `Armed tool "${tool}" not in allowed list for window "${windowId}". Allowed: [${allowedTools.join(", ")}]`;
			logger.warn("canvas armed tool rejected", { windowId, tool, allowedTools });
			reply?.({ error: errMsg });
			await session.sendCustomMessage({
				customType: "canvas-tool-invoke",
				content: `Armed tool rejected: ${tool} (window: ${windowId}) — not in allowlist`,
				display: false,
				attribution: "agent",
				details: { windowId, tool, args, error: errMsg },
			});
			return;
		}

		let result: AgentToolResult<unknown>;
		let invokeError: string | undefined;
		const agentTool = toolRegistry.get(tool);

		if (!agentTool) {
			const fallbackResult = await tryCanvasTidewaveFallback(tool, args as Record<string, unknown>).catch(err => {
				invokeError = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: invokeError }],
					details: { fallback: "tidewave-http", error: invokeError },
				} satisfies AgentToolResult<unknown>;
			});
			if (fallbackResult) {
				result = fallbackResult;
			} else {
				const errMsg = `Armed tool "${tool}" is not registered in this session`;
				logger.warn("canvas armed tool not found", { windowId, tool });
				reply?.({ error: errMsg });
				await session.sendCustomMessage({
					customType: "canvas-tool-invoke",
					content: `Armed tool not found: ${tool} (window: ${windowId})`,
					display: false,
					attribution: "agent",
					details: { windowId, tool, args, error: errMsg },
				});
				return;
			}
		} else {
			try {
				result = await agentTool.execute(
					`canvas-armed-${windowId}-${Date.now()}`,
					args as Record<string, unknown>,
					undefined,
					undefined,
					toolContextStore.getContext(),
				);
			} catch (err) {
				invokeError = err instanceof Error ? err.message : String(err);
				result = { content: [{ type: "text", text: invokeError }], details: {} };
			}
		}

		if (reply) {
			const text = result.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map(c => c.text)
				.join("");
			reply(invokeError ? { error: invokeError } : { result: text });
		}

		await session.sendCustomMessage({
			customType: "canvas-tool-invoke",
			content: invokeError
				? `Armed tool failed: ${tool} (window: ${windowId}) — ${invokeError}`
				: `Armed tool: ${tool} (window: ${windowId})`,
			display: false,
			attribution: "agent",
			details: { windowId, tool, args, error: invokeError },
		});
	});

	// Drain queued events between agent turns.
	// P1-P3 events accumulate in the PriorityEventBus queue and are processed
	// when the agent loop reaches a natural pause point (turn_end, agent_end).
	session.subscribe(event => {
		if (event.type === "turn_end" || event.type === "agent_end") {
			eventBus.drain().catch(err => {
				logger.error("EventBus drain failed", { error: String(err) });
			});
		}
	});

	// Wire scoped orchestrator lifecycle manager.
	// Orchestrators are lightweight agent sessions bound to canvas windows.
	const orchestratorManager = new CanvasOrchestratorManager({
		eventBus,
		cwd: cwd ?? process.cwd(),
		executorDefaults: {
			settings: options.settings,
			modelRegistry,
		},
	});
	orchestratorManager.start();

	// Wire task subagent lifecycle manager.
	// Tasks are full-capability subagents dispatched from canvas windows (e.g. quick-fix).
	const taskManager = new CanvasTaskManager({
		eventBus,
		cwd: cwd ?? process.cwd(),
		executorDefaults: {
			settings: options.settings,
			modelRegistry,
		},
	});
	taskManager.start();
	toolSession.orchestratorManager = orchestratorManager;
	toolSession.taskManager = taskManager;

	const spellcastModifiedPaths = new Map<string, string[]>();
	if (spellcastSessionContext.discoveredManifests.length > 0) {
		eventBus.subscribe("tool_execution_start", raw => {
			const event = raw as { toolCallId: string; toolName: string; args: unknown };
			const modifiedPaths = extractModifiedPaths(event.toolName, event.args, cwd);
			if (modifiedPaths.length > 0) {
				spellcastModifiedPaths.set(event.toolCallId, modifiedPaths);
			}
		});
		eventBus.subscribe("tool_execution_end", async raw => {
			if (!session) return;
			const event = raw as { toolCallId: string; isError: boolean };
			const modifiedPaths = spellcastModifiedPaths.get(event.toolCallId);
			if (!modifiedPaths) return;
			spellcastModifiedPaths.delete(event.toolCallId);
			if (event.isError) return;
			for (const filePath of modifiedPaths) {
				const match = checkFileAgainstManifests(filePath, spellcastSessionContext);
				if (match) {
					await session.followUp(formatSpellcastSyncNote(match));
					break;
				}
			}
		});
	}

	// Wire full agent requests from canvas: route to session.followUp() and acknowledge optional replies.
	eventBus.subscribe(CANVAS_AGENT_CHANNEL, async (raw: unknown) => {
		const payload = raw as CanvasAgentPayload;
		if (!session) {
			payload.reply?.({
				action: "agent_handoff_result",
				ok: false,
				error: "Canvas agent request failed: no active session.",
			});
			return;
		}
		try {
			const prompt = payload.context
				? `${payload.assignment}\n\nContext: ${JSON.stringify(payload.context)}`
				: payload.assignment;
			const content = `[Canvas agent request from window ${payload.windowId}]\n\n${prompt}`;
			// Reply immediately so QML transitions out of "Sending..." before the turn starts.
			payload.reply?.({
				action: "agent_handoff_result",
				ok: true,
				status: "submitted",
				message: "Submitted the Phoenix inspector request to the active agent session.",
			});
			// triggerTurn: true starts a new agent turn; plain followUp() only queues.
			await session.sendCustomMessage(
				{
					customType: "canvas-agent-request",
					content,
					display: true,
					attribution: "user",
					details: { windowId: payload.windowId },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch (error) {
			payload.reply?.({
				action: "agent_handoff_result",
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});
	return {
		session,

		extensionsResult,

		setToolUIContext,

		mcpManager,

		modelFallbackMessage,
		spellcastSessionContext,
		spellcastReport,
		spellcastingWarning: spellcastingWarning ?? undefined,



		eventBus,

		orchestratorManager,

		taskManager,

		loopManager,
	};
}

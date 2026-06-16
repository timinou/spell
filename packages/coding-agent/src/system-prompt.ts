/**
 * System prompt construction and project context loading
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@spell/pi-agent-core";
import type { SystemPromptBlock } from "@spell/pi-ai";
import { $env, getGpuCachePath, getProjectDir, hasFsCode, isEnoent, logger } from "@spell/pi-utils";
import { $ } from "bun";
import { contextFileCapability } from "./capability/context-file";
import { systemPromptCapability } from "./capability/system-prompt";
import { CACHE_BOUNDARY_MARKER, renderPromptTemplate } from "./config/prompt-templates";
import type { Settings, SkillsSettings } from "./config/settings";
import { type ContextFile, loadCapability, type SystemPrompt as SystemPromptFile } from "./discovery";
import { loadSkills, type Skill } from "./extensibility/skills";
import customSystemPromptTemplate from "./prompts/system/custom-system-prompt.md" with { type: "text" };
import systemPromptTemplate from "./prompts/system/system-prompt.md" with { type: "text" };
import { getGitToplevelSync } from "./session/git-baseline";

// === STARTUP-DBG (BUG: blank screen after migration prompt). Disable with SPELL_STARTUP_DBG=0. ===
const _dbgStartupT0_sp = performance.now();
function dbgStartup(step: string, ctx?: Record<string, unknown>): void {
	if (process.env.SPELL_STARTUP_DBG !== "1") return;
	try {
		const elapsed = Math.round(performance.now() - _dbgStartupT0_sp);
		const ctxStr = ctx ? " " + JSON.stringify(ctx) : "";
		process.stderr.write(`[STARTUP-DBG sp +${elapsed}ms] ${step}${ctxStr}\n`);
	} catch {}
}

function firstNonEmpty(...values: (string | undefined | null)[]): string | null {
	for (const value of values) {
		const trimmed = value?.trim();
		if (trimmed) return trimmed;
	}
	return null;
}

function parseWmicTable(output: string, header: string): string | null {
	const lines = output
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
	const filtered = lines.filter(line => line.toLowerCase() !== header.toLowerCase());
	return filtered[0] ?? null;
}

const AGENTS_MD_MIN_DEPTH = 1;
const AGENTS_MD_MAX_DEPTH = 4;
const AGENTS_MD_LIMIT = 200;
const SYSTEM_PROMPT_PREP_TIMEOUT_MS = 5000;
const AGENTS_MD_EXCLUDED_DIRS = new Set(["node_modules", ".git"]);

export async function raceWithTimeout<T>(
	name: string,
	promise: Promise<T>,
	fallback: T,
	timeoutMs: number,
): Promise<T> {
	const result = await Promise.race([
		promise.then(v => ({ ok: true as const, value: v })),
		Bun.sleep(timeoutMs).then(() => ({ ok: false as const })),
	]);
	if (!result.ok) {
		logger.warn(`System prompt: ${name} timed out (${timeoutMs}ms); continuing without.`);
		process.stderr.write(`Warning: ${name} timed out after ${timeoutMs}ms; proceeding without it.\n`);
		return fallback;
	}
	return result.value;
}

interface AgentsMdSearch {
	scopePath: string;
	limit: number;
	pattern: string;
	files: string[];
}

function normalizePath(value: string): string {
	return value.replace(/\\/g, "/");
}

function shouldSkipAgentsDir(name: string): boolean {
	if (AGENTS_MD_EXCLUDED_DIRS.has(name)) return true;
	return name.startsWith(".");
}

async function collectAgentsMdFiles(
	root: string,
	dir: string,
	depth: number,
	limit: number,
	discovered: Set<string>,
): Promise<void> {
	if (depth > AGENTS_MD_MAX_DEPTH || discovered.size >= limit) {
		return;
	}

	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}

	if (depth >= AGENTS_MD_MIN_DEPTH) {
		const hasAgentsMd = entries.some(entry => entry.isFile() && entry.name === "AGENTS.md");
		if (hasAgentsMd) {
			const relPath = normalizePath(path.relative(root, path.join(dir, "AGENTS.md")));
			if (relPath.length > 0) {
				discovered.add(relPath);
			}
			if (discovered.size >= limit) {
				return;
			}
		}
	}

	if (depth === AGENTS_MD_MAX_DEPTH) {
		return;
	}

	const childDirs = entries
		.filter(entry => entry.isDirectory() && !shouldSkipAgentsDir(entry.name))
		.map(entry => entry.name)
		.sort();

	await Promise.all(
		childDirs.map(async child => {
			if (discovered.size >= limit) return;
			await collectAgentsMdFiles(root, path.join(dir, child), depth + 1, limit, discovered);
		}),
	);
}

async function listAgentsMdFiles(root: string, limit: number): Promise<string[]> {
	try {
		const discovered = new Set<string>();
		await collectAgentsMdFiles(root, root, 0, limit, discovered);
		return Array.from(discovered).sort().slice(0, limit);
	} catch {
		return [];
	}
}

export async function buildAgentsMdSearch(cwd: string): Promise<AgentsMdSearch> {
	const files = await listAgentsMdFiles(cwd, AGENTS_MD_LIMIT);
	return {
		scopePath: ".",
		limit: AGENTS_MD_LIMIT,
		pattern: `AGENTS.md depth ${AGENTS_MD_MIN_DEPTH}-${AGENTS_MD_MAX_DEPTH}`,
		files,
	};
}

async function getGpuModel(): Promise<string | null> {
	switch (process.platform) {
		case "win32": {
			const output = await $`wmic path win32_VideoController get name`
				.quiet()
				.text()
				.catch(() => null);
			return output ? parseWmicTable(output, "Name") : null;
		}
		case "linux": {
			const output = await $`lspci`
				.quiet()
				.text()
				.catch(() => null);
			if (!output) return null;
			const gpus: Array<{ name: string; priority: number }> = [];
			for (const line of output.split("\n")) {
				if (!/(VGA|3D|Display)/i.test(line)) continue;
				const parts = line.split(":");
				const name = parts.length > 1 ? parts.slice(1).join(":").trim() : line.trim();
				const nameLower = name.toLowerCase();
				// Skip BMC/server management adapters
				if (/aspeed|matrox g200|mgag200/i.test(name)) continue;
				// Prioritize discrete GPUs
				let priority = 0;
				if (
					nameLower.includes("nvidia") ||
					nameLower.includes("geforce") ||
					nameLower.includes("quadro") ||
					nameLower.includes("rtx")
				) {
					priority = 3;
				} else if (nameLower.includes("amd") || nameLower.includes("radeon") || nameLower.includes("rx ")) {
					priority = 3;
				} else if (nameLower.includes("intel")) {
					priority = 1;
				} else {
					priority = 2;
				}
				gpus.push({ name, priority });
			}
			if (gpus.length === 0) return null;
			gpus.sort((a, b) => b.priority - a.priority);
			return gpus[0].name;
		}
		default:
			return null;
	}
}

function getTerminalName(): string | undefined {
	const termProgram = Bun.env.TERM_PROGRAM;
	const termProgramVersion = Bun.env.TERM_PROGRAM_VERSION;
	if (termProgram) {
		return termProgramVersion ? `${termProgram} ${termProgramVersion}` : termProgram;
	}

	if (Bun.env.WT_SESSION) return "Windows Terminal";

	const term = firstNonEmpty(Bun.env.TERM, Bun.env.COLORTERM, Bun.env.TERMINAL_EMULATOR);
	return term ?? undefined;
}

/** Cached system info structure */
interface GpuCache {
	gpu: string;
}

function getSystemInfoCachePath(): string {
	return getGpuCachePath();
}

async function loadGpuCache(): Promise<GpuCache | null> {
	try {
		const cachePath = getSystemInfoCachePath();
		const content = await Bun.file(cachePath).json();
		return content as GpuCache;
	} catch {
		return null;
	}
}

async function saveGpuCache(info: GpuCache): Promise<void> {
	try {
		const cachePath = getSystemInfoCachePath();
		await Bun.write(cachePath, JSON.stringify(info, null, "\t"));
	} catch {
		// Silently ignore cache write failures
	}
}

async function getCachedGpu(): Promise<string | undefined> {
	const cached = await logger.timeAsync("getCachedGpu:loadGpuCache", loadGpuCache);
	if (cached) return cached.gpu;
	const gpu = await logger.timeAsync("getCachedGpu:getGpuModel", getGpuModel);
	if (gpu) await logger.timeAsync("getCachedGpu:saveGpuCache", saveGpuCache, { gpu });
	return gpu ?? undefined;
}
async function getEnvironmentInfo(): Promise<Array<{ label: string; value: string }>> {
	const gpu = await logger.timeAsync("getEnvironmentInfo:getCachedGpu", getCachedGpu);
	const cpus = os.cpus();
	const entries: Array<{ label: string; value: string | undefined }> = [
		{ label: "OS", value: `${os.platform()} ${os.release()}` },
		{ label: "Distro", value: os.type() },
		{ label: "Kernel", value: os.version() },
		{ label: "Arch", value: os.arch() },
		{ label: "CPU", value: `${cpus[0]?.model}` },
		{ label: "GPU", value: gpu },
		{ label: "Terminal", value: getTerminalName() },
	];
	return entries.filter((e): e is { label: string; value: string } => !!e.value);
}

/** Resolve input as file path or literal string */
export async function resolvePromptInput(input: string | undefined, description: string): Promise<string | undefined> {
	if (!input) {
		return undefined;
	} else if (input.includes("\n")) {
		return input;
	}

	try {
		return await Bun.file(input).text();
	} catch (error) {
		if (!hasFsCode(error, "ENAMETOOLONG") && !isEnoent(error)) {
			logger.warn(`Could not read ${description} file`, { path: input, error: String(error) });
		}
		return input;
	}
}

export interface LoadContextFilesOptions {
	/** Working directory to start walking up from. Default: getProjectDir() */
	cwd?: string;
}

/**
 * Load all project context files using the capability API.
 * Returns {path, content, depth} entries for all discovered context files.
 * Files are sorted by depth (descending) so files closer to cwd appear last/more prominent.
 */
export async function loadProjectContextFiles(
	options: LoadContextFilesOptions = {},
): Promise<Array<{ path: string; content: string; depth?: number }>> {
	const resolvedCwd = options.cwd ?? getProjectDir();

	const result = await loadCapability(contextFileCapability.id, { cwd: resolvedCwd });

	// Convert ContextFile items and preserve depth info
	const files = result.items.map(item => {
		const contextFile = item as ContextFile;
		return {
			path: contextFile.path,
			content: contextFile.content,
			depth: contextFile.depth,
		};
	});

	// Sort by depth (descending): higher depth (farther from cwd) comes first,
	// so files closer to cwd appear later and are more prominent
	files.sort((a, b) => {
		const depthA = a.depth ?? -1;
		const depthB = b.depth ?? -1;
		return depthB - depthA;
	});

	return files;
}

/**
 * Load system prompt customization files (SYSTEM.md).
 * Returns combined content from all discovered SYSTEM.md files.
 */
export async function loadSystemPromptFiles(options: LoadContextFilesOptions = {}): Promise<string | null> {
	const resolvedCwd = options.cwd ?? getProjectDir();

	const result = await loadCapability<SystemPromptFile>(systemPromptCapability.id, { cwd: resolvedCwd });

	if (result.items.length === 0) return null;

	// Combine all SYSTEM.md contents (user-level first, then project-level)
	const userLevel = result.items.filter(item => item.level === "user");
	const projectLevel = result.items.filter(item => item.level === "project");

	const parts: string[] = [];
	for (const item of [...userLevel, ...projectLevel]) {
		parts.push(item.content);
	}

	return parts.join("\n\n");
}

export interface SystemPromptToolMetadata {
	label: string;
	description: string;
}

export function buildSystemPromptToolMetadata(
	tools: Map<string, AgentTool>,
	overrides: Partial<Record<string, Partial<SystemPromptToolMetadata>>> = {},
): Map<string, SystemPromptToolMetadata> {
	return new Map(
		Array.from(tools.entries(), ([name, tool]) => {
			const toolRecord = tool as AgentTool & { label?: string; description?: string };
			const override = overrides[name];
			return [
				name,
				{
					label: override?.label ?? (typeof toolRecord.label === "string" ? toolRecord.label : ""),
					description:
						override?.description ?? (typeof toolRecord.description === "string" ? toolRecord.description : ""),
				},
			] as const;
		}),
	);
}

function normalizeSkillGlobs(globs: string[] | undefined): string[] {
	return (globs ?? []).map(glob => glob.trim()).filter(glob => glob.length > 0);
}

async function skillMatchesWorkspace(cwd: string, globs: string[] | undefined): Promise<boolean> {
	const normalizedGlobs = normalizeSkillGlobs(globs);
	if (normalizedGlobs.length === 0) return true;
	for (const glob of normalizedGlobs) {
		const matcher = new Bun.Glob(glob);
		try {
			for await (const _ of matcher.scan({ cwd, onlyFiles: true })) {
				return true;
			}
		} catch {}
	}
	return false;
}

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. */
	tools?: Map<string, SystemPromptToolMetadata>;
	/** Tool names to include in prompt. */
	toolNames?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Repeat full tool descriptions in system prompt. Default: false */
	repeatToolDescriptions?: boolean;
	/** Skills settings for discovery. */
	skillsSettings?: SkillsSettings;
	/** Settings instance for feature-driven prompt sections. */
	settings?: Settings;
	/** Whether this prompt is being built for a delegated subagent session. */
	isSubagent?: boolean;
	/** Working directory. Default: getProjectDir() */
	cwd?: string;
	/** Pre-loaded context files (skips discovery if provided). */
	contextFiles?: Array<{ path: string; content: string; depth?: number }>;
	/** Skills provided directly to system prompt construction. */
	skills?: Skill[];
	/** Pre-computed AGENTS.md search result. */
	agentsMdSearch?: AgentsMdSearch;
	/** Pre-computed SYSTEM.md customization. */
	systemPromptCustomization?: string | null;
	/** Pre-loaded rulebook rules (descriptions, excluding TTSR and always-apply). */
	rules?: Array<{ name: string; description?: string; path: string; globs?: string[] }>;
	/** Intent field name injected into every tool schema. If set, explains the field in the prompt. */
	intentField?: string;
	/** Whether MCP tool discovery is active for this prompt build. */
	mcpDiscoveryMode?: boolean;
	/** Discoverable MCP server summaries to advertise when discovery mode is active. */
	mcpDiscoveryServerSummaries?: string[];
	/** Encourage the agent to delegate via tasks unless changes are trivial. */
	eagerTasks?: boolean;
	/** Whether task dispatches auto-create roster entries in this session. */
	autoRosterEnabled?: boolean;
	/** Tool names classified as specialized tier (get compact descriptions in prompt). */
	specializedToolNames?: string[];
	/**
	 * Active model identity, used to condition provider-specific prompt blocks
	 * (e.g. GPT-5/codex persistence + verification guidance). Absent → the
	 * default (Claude-dialect) prompt is rendered, preserving prior behavior.
	 */
	model?: { provider?: string; api?: string; id?: string };
}

/**
 * Detects the OpenAI GPT-5 / codex model family from a model identity.
 *
 * GPT-5+ follows instructions far more literally than Claude: it benefits from
 * an explicit persistence + verification + anti-fabrication block and from
 * resolving the terse↔complete tension that the Claude-tuned default leaves
 * implicit. See FEAT-821. Matches on api (`openai-codex*`), provider
 * (`openai*`), or model id (`gpt-5*` / `*codex*`).
 */
export function isGptFamilyModel(model: { provider?: string; api?: string; id?: string } | undefined): boolean {
	if (!model) return false;
	const api = (model.api ?? "").toLowerCase();
	const provider = (model.provider ?? "").toLowerCase();
	const id = (model.id ?? "").toLowerCase();
	if (api.startsWith("openai-codex")) return true;
	if (provider.startsWith("openai")) return true;
	if (/\bgpt-5/.test(id) || id.includes("codex")) return true;
	return false;
}

/** Build the system prompt with tools, guidelines, and context */
export async function buildSystemPrompt(options: BuildSystemPromptOptions = {}): Promise<SystemPromptBlock[]> {
	dbgStartup("bsp:enter", {
		hasCustom: !!options.customPrompt,
		toolCount: options.toolNames?.length ?? options.tools?.size ?? -1,
	});
	if ($env.NULL_PROMPT === "true") {
		return [{ text: "", stable: true }];
	}

	const {
		customPrompt,
		tools,
		appendSystemPrompt,
		repeatToolDescriptions = false,
		skillsSettings,
		settings,
		isSubagent = false,
		toolNames: providedToolNames,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
		agentsMdSearch: providedAgentsMdSearch,
		systemPromptCustomization: providedSystemPromptCustomization,
		rules,
		intentField,
		mcpDiscoveryMode = false,
		mcpDiscoveryServerSummaries = [],
		eagerTasks,
		autoRosterEnabled = false,
		specializedToolNames = [],
		model,
	} = options;
	const isGptFamily = isGptFamilyModel(model);
	const resolvedCwd = cwd ?? getProjectDir();
	const resolvedEagerTasks = eagerTasks ?? (settings?.get("task.eager") as boolean | undefined) ?? false;

	dbgStartup("bsp:before:resolvePromptInputs");
	const [resolvedCustomPrompt, resolvedAppendPrompt] = await Promise.all([
		resolvePromptInput(customPrompt, "system prompt"),
		resolvePromptInput(appendSystemPrompt, "append system prompt"),
	]);
	dbgStartup("bsp:after:resolvePromptInputs");

	const systemPromptCustomizationPromise: Promise<string | null> =
		providedSystemPromptCustomization !== undefined
			? Promise.resolve(providedSystemPromptCustomization)
			: logger.timeAsync("loadSystemPromptFiles", loadSystemPromptFiles, { cwd: resolvedCwd });
	const contextFilesPromise: Promise<Array<{ path: string; content: string; depth?: number }>> = providedContextFiles
		? Promise.resolve(providedContextFiles)
		: logger.timeAsync("loadProjectContextFiles", loadProjectContextFiles, { cwd: resolvedCwd });
	const agentsMdSearchPromise =
		providedAgentsMdSearch !== undefined
			? Promise.resolve(providedAgentsMdSearch)
			: logger.timeAsync("buildAgentsMdSearch", buildAgentsMdSearch, resolvedCwd);
	const skillsPromise: Promise<Skill[]> =
		providedSkills !== undefined
			? Promise.resolve(providedSkills)
			: skillsSettings?.enabled !== false
				? loadSkills({ ...skillsSettings, cwd: resolvedCwd }).then(result => result.skills)
				: Promise.resolve([]);

	dbgStartup("bsp:before:Promise.all(prep races)", {
		haveSysCustomization: providedSystemPromptCustomization !== undefined,
		haveContextFiles: !!providedContextFiles,
		haveAgentsMdSearch: providedAgentsMdSearch !== undefined,
		haveSkills: providedSkills !== undefined,
	});
	const [systemPromptCustomization, contextFiles, agentsMdSearch, skills] = await Promise.all([
		raceWithTimeout("system prompt files", systemPromptCustomizationPromise, null, SYSTEM_PROMPT_PREP_TIMEOUT_MS),
		raceWithTimeout(
			"project context files",
			contextFilesPromise,
			providedContextFiles ?? [],
			SYSTEM_PROMPT_PREP_TIMEOUT_MS,
		),
		raceWithTimeout(
			"AGENTS.md discovery",
			agentsMdSearchPromise,
			{
				scopePath: ".",
				limit: AGENTS_MD_LIMIT,
				pattern: `AGENTS.md depth ${AGENTS_MD_MIN_DEPTH}-${AGENTS_MD_MAX_DEPTH}`,
				files: [],
			},
			SYSTEM_PROMPT_PREP_TIMEOUT_MS,
		),
		raceWithTimeout("skills discovery", skillsPromise, providedSkills ?? [], SYSTEM_PROMPT_PREP_TIMEOUT_MS),
	]);
	dbgStartup("bsp:after:Promise.all(prep races)");

	const date = new Date().toISOString().slice(0, 10);
	const dateTime = date;
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	// Surface cwd vs git-toplevel asymmetry: when the session cwd is below
	// the git working tree, agents that read project-rooted paths from
	// AGENTS.md / specs / plan items will silently double-prefix when
	// passing them to path-resolving tools (see BUG: cwd_prefix_duplication).
	// We render a one-line warning only when they differ; no noise at
	// repo-root sessions.
	const gitToplevelRaw = getGitToplevelSync(resolvedCwd);
	const gitToplevel = gitToplevelRaw ? gitToplevelRaw.replace(/\\/g, "/") : null;
	const cwdBelowGitRoot = gitToplevel !== null && gitToplevel !== promptCwd && promptCwd.startsWith(`${gitToplevel}/`);
	const gitRootForPrompt = cwdBelowGitRoot ? gitToplevel : null;

	const appendPromptParts = [resolvedAppendPrompt].filter(
		(section): section is string => typeof section === "string" && section.trim().length > 0,
	);

	// Build tool metadata for system prompt rendering
	// Priority: explicit list > tools map > defaults
	// Default includes bash; actual availability determined by settings in createTools
	let toolNames = providedToolNames;
	if (!toolNames) {
		if (tools) {
			// Tools map provided
			toolNames = Array.from(tools.keys());
		} else {
			// Use defaults
			toolNames = ["read", "bash", "edit", "write"]; // TODO: Why?
		}
	}

	// Build tool descriptions for system prompt rendering
	const toolInfo = toolNames.map(name => ({
		name,
		label: tools?.get(name)?.label ?? "",
		description: tools?.get(name)?.description ?? "",
	}));

	dbgStartup("bsp:before:skill workspace match", { skillCount: skills.length, hasRead: !!tools?.has("read") });
	const hasRead = tools?.has("read");
	const filteredSkills = hasRead
		? await Promise.all(
				skills.map(async skill => ({ skill, matches: await skillMatchesWorkspace(resolvedCwd, skill.globs) })),
			).then(entries =>
				entries
					.filter(({ skill, matches }) => matches || normalizeSkillGlobs(skill.globs).length === 0)
					.map(({ skill }) => skill),
			)
		: [];
	dbgStartup("bsp:after:skill workspace match", { filteredCount: filteredSkills.length });
	dbgStartup("bsp:before:getEnvironmentInfo");
	const environment = await logger.timeAsync("getEnvironmentInfo", getEnvironmentInfo);
	dbgStartup("bsp:after:getEnvironmentInfo");
	const data = {
		systemPromptCustomization: systemPromptCustomization ?? "",
		customPrompt: resolvedCustomPrompt,
		appendPrompt: appendPromptParts.join("\n\n"),
		tools: toolNames,
		toolInfo,
		repeatToolDescriptions,
		environment,
		contextFiles,
		agentsMdSearch,
		skills: filteredSkills,
		rules: rules ?? [],
		date,
		dateTime,
		cwd: promptCwd,
		gitRoot: gitRootForPrompt,
		intentTracing: !!intentField,
		intentField: intentField ?? "",
		mcpDiscoveryMode,
		hasMCPDiscoveryServers: mcpDiscoveryServerSummaries.length > 0,
		mcpDiscoveryServerSummaries,
		eagerTasks: resolvedEagerTasks,
		autoRosterEnabled,
		specializedToolNames,
		hasSpecializedTools: specializedToolNames.length > 0,
		isGptFamily,
	};
	dbgStartup("bsp:before:renderPromptTemplate");
	const rendered = renderPromptTemplate(
		resolvedCustomPrompt ? customSystemPromptTemplate : systemPromptTemplate,
		data,
	);
	dbgStartup("bsp:after:renderPromptTemplate", { renderedLen: rendered.length });
	const boundaryIndex = rendered.indexOf(CACHE_BOUNDARY_MARKER);
	if (boundaryIndex === -1) {
		return [{ text: rendered, stable: true }];
	}
	const stablePrefix = rendered.slice(0, boundaryIndex);
	const dynamicSuffix = rendered.slice(boundaryIndex + CACHE_BOUNDARY_MARKER.length);
	const blocks: SystemPromptBlock[] = [{ text: stablePrefix, stable: true }];
	if (dynamicSuffix.trim().length > 0) {
		blocks.push({ text: dynamicSuffix, stable: false });
	}
	return blocks;
}

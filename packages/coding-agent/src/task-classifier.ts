/**
 * Lightweight keyword heuristic that analyzes the initial user message
 * to recommend which specialized tools should be pre-activated and which
 * standard tools can be skipped.
 *
 * This runs at session start (zero LLM calls) and feeds into the tool
 * tiering system from FEAT-192.
 */
import { getToolTier } from "./tools";

export interface TaskClassification {
	/** Specialized tools to promote into the initial active set. */
	activate: string[];
	/** Standard tools to demote from the initial active set. */
	skip: string[];
	/** Brief tag describing the detected task type. */
	taskType: string;
}

interface KeywordRule {
	/** Patterns to match (case-insensitive substring). */
	patterns: string[];
	/** Tools to activate when matched. */
	activate?: string[];
	/** Tools to skip when matched. */
	skip?: string[];
	/** Task type label. */
	taskType: string;
}

const KEYWORD_RULES: KeywordRule[] = [
	{
		patterns: ["qml", "canvas", "qt ", "qt6", "gallery", "ui window", "desktop window"],
		activate: ["canvas"],
		taskType: "ui-canvas",
	},
	{
		patterns: ["browser", "puppeteer", "screenshot", "web page", "webpage", "navigate to"],
		activate: ["browser"],
		taskType: "browser",
	},
	{
		patterns: ["notebook", "jupyter", ".ipynb", "ipynb"],
		activate: ["notebook"],
		taskType: "notebook",
	},
	{
		patterns: ["python", "pandas", "numpy", "matplotlib", "scipy", "pytorch", "tensorflow"],
		activate: ["python"],
		taskType: "python",
	},
	{
		patterns: ["mermaid", "diagram", "flowchart", "sequence diagram"],
		activate: ["render_mermaid"],
		taskType: "diagram",
	},
	{
		patterns: ["image", "generate image", "gemini image", "logo", "brand asset", "mood board"],
		activate: ["canvas"],
		taskType: "image-gen",
	},
	{
		patterns: ["ssh", "remote server", "remote host", "sshfs"],
		activate: ["ssh"],
		taskType: "ssh",
	},
	{
		patterns: ["loop", "iteration", "loop_prepare", "loop_launch"],
		activate: ["loop_prepare", "loop_launch", "loop_done"],
		taskType: "loop",
	},
	{
		patterns: ["gateway", "localhost", ".localhost", "register service"],
		activate: ["gateway"],
		taskType: "gateway",
	},
	{
		patterns: ["calculator", "calculate", "arithmetic", "math expression"],
		activate: ["calc"],
		taskType: "calculation",
	},
	// Simple questions / explanations typically don't need AST tools
	{
		patterns: ["what does", "what is", "explain", "how does", "why does", "describe", "tell me about", "summarize"],
		skip: ["ast_grep", "ast_edit", "emacs_code"],
		taskType: "question",
	},
];

/**
 * Classify a user message to determine tool activation/deactivation recommendations.
 * Returns empty activate/skip arrays if no strong signal is detected.
 */
export function classifyTask(userMessage: string): TaskClassification {
	if (!userMessage || userMessage.length === 0) {
		return { activate: [], skip: [], taskType: "unknown" };
	}

	const lower = userMessage.toLowerCase();
	const activateSet = new Set<string>();
	const skipSet = new Set<string>();
	const taskTypes: string[] = [];

	for (const rule of KEYWORD_RULES) {
		const matched = rule.patterns.some(pattern => lower.includes(pattern));
		if (!matched) continue;

		taskTypes.push(rule.taskType);
		if (rule.activate) {
			for (const tool of rule.activate) activateSet.add(tool);
		}
		if (rule.skip) {
			for (const tool of rule.skip) skipSet.add(tool);
		}
	}

	// Don't skip a tool if we're also activating it
	for (const tool of activateSet) {
		skipSet.delete(tool);
	}

	// Only skip standard-tier tools (never skip core)
	const filteredSkip = [...skipSet].filter(name => getToolTier(name) === "standard");

	return {
		activate: [...activateSet],
		skip: filteredSkip,
		taskType: taskTypes.length > 0 ? taskTypes.join("+") : "general",
	};
}

/**
 * Apply task classification to an initial tool set.
 * Adds recommended activations and removes recommended skips.
 *
 * @param initialToolNames - The current initial tool set (core + standard)
 * @param deferredToolNames - The deferred tools available for promotion
 * @param classification - The task classification result
 * @returns Updated tool lists: { activeToolNames, deferredToolNames }
 */
export function applyClassification(
	initialToolNames: string[],
	deferredToolNames: string[],
	classification: TaskClassification,
): { activeToolNames: string[]; deferredToolNames: string[] } {
	const activeSet = new Set(initialToolNames);
	const deferredSet = new Set(deferredToolNames);

	// Promote: move from deferred to active
	for (const tool of classification.activate) {
		if (deferredSet.has(tool)) {
			activeSet.add(tool);
			deferredSet.delete(tool);
		}
	}

	// Demote: move from active to deferred
	for (const tool of classification.skip) {
		if (activeSet.has(tool) && getToolTier(tool) !== "core") {
			activeSet.delete(tool);
			deferredSet.add(tool);
		}
	}

	return {
		activeToolNames: [...activeSet],
		deferredToolNames: [...deferredSet],
	};
}

import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { type AgentRule, type AgentRuleConflict, matchAgentRules } from "../config/agents-kdl";
import { resolveConfiguredModelPatterns } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import type { AgentDefinition } from "./types";

/**
 * The effective configuration for an agent after resolving all override sources.
 */
export interface EffectiveAgentConfig {
	/** Resolved model patterns (provider/model strings) */
	model: string[];
	/** Resolved thinking level */
	thinkingLevel?: ThinkingLevel;
	/** Resolved tool list (replaces agent defaults when set by a rule) */
	tools?: string[];
	/** Whether this agent is disabled */
	disabled: boolean;
	/** The winning rule that provided the overrides, if any */
	rule?: AgentRule;
	/** Conflicts detected during resolution */
	conflicts: AgentRuleConflict[];
	/** Which source provided the model */
	modelSource: "per-call" | "rule" | "settings" | "frontmatter" | "role-alias" | "default";
	/** The selector string of the winning rule, if source is "rule" */
	ruleSelector?: string;
	/** The file path of the winning rule's source, if source is "rule" */
	ruleSourcePath?: string;
}

/**
 * Input to the agent configuration resolver.
 */
export interface ResolveAgentConfigInput {
	/** The agent definition (frontmatter-parsed) */
	agent: AgentDefinition;
	/** The agent name as dispatched */
	agentName: string;
	/** Per-task model override from TaskItem.model */
	perCallTaskModel?: string;
	/** Per-batch model override from TaskParams.model */
	perCallBatchModel?: string;
	/** Rules from project spell.kdl */
	projectRules: AgentRule[];
	/** Rules from user ~/.spell/spell.kdl */
	userRules: AgentRule[];
	/** Settings instance for DB overrides */
	settings: Settings;
	/** Active model pattern from parent session */
	activeModelPattern?: string;
	/** Fallback model pattern from parent session */
	fallbackModelPattern?: string;
}

/**
 * Resolve the effective agent configuration by applying all override sources
 * in precedence order.
 *
 * Precedence (highest to lowest):
 * 1. Per-task model (TaskItem.model)
 * 2. Per-batch model (TaskParams.model)
 * 3. Project spell.kdl agent rules
 * 4. User spell.kdl agent rules
 * 5. Settings DB task.agentModelOverrides[agentName]
 * 6. Agent frontmatter model:
 * 7. Role alias resolution
 * 8. Parent active model
 *
 * Placeholder — full implementation in FEAT-646::impl (wave-4).
 */
export function resolveAgentEffectiveConfig(input: ResolveAgentConfigInput): EffectiveAgentConfig {
	const {
		agent,
		agentName,
		perCallTaskModel,
		perCallBatchModel,
		projectRules,
		userRules,
		settings,
		activeModelPattern,
		fallbackModelPattern,
	} = input;

	// Merge rules: project rules after user rules (project wins ties via declarationOrder)
	const mergedRules = [...userRules, ...projectRules];

	const { winning, conflicts } = matchAgentRules(agentName, mergedRules);

	// Disabled: rule-level disabled wins, otherwise check settings DB
	const disabledAgents = (settings.get("task.disabledAgents") as string[]) ?? [];
	const disabled = winning?.disabled === true || disabledAgents.includes(agentName);

	// Resolve model by precedence chain
	let model: string[] = [];
	let modelSource: EffectiveAgentConfig["modelSource"] = "default";

	const taskModel = perCallTaskModel?.trim();
	const batchModel = perCallBatchModel?.trim();

	if (taskModel) {
		const resolved = resolveConfiguredModelPatterns(taskModel, settings);
		if (resolved.length > 0) {
			model = resolved;
			modelSource = "per-call";
		}
	}

	if (model.length === 0 && batchModel) {
		const resolved = resolveConfiguredModelPatterns(batchModel, settings);
		if (resolved.length > 0) {
			model = resolved;
			modelSource = "per-call";
		}
	}

	if (model.length === 0 && winning?.model && winning.model.length > 0) {
		const resolved = resolveConfiguredModelPatterns(winning.model, settings);
		if (resolved.length > 0) {
			model = resolved;
			modelSource = "rule";
		}
	}

	if (model.length === 0) {
		const agentModelOverrides = settings.get("task.agentModelOverrides") as Record<string, string> | undefined;
		const settingsOverride = agentModelOverrides?.[agentName];
		if (settingsOverride) {
			const resolved = resolveConfiguredModelPatterns(settingsOverride, settings);
			if (resolved.length > 0) {
				model = resolved;
				modelSource = "settings";
			}
		}
	}

	if (model.length === 0 && agent.model && agent.model.length > 0) {
		const resolved = resolveConfiguredModelPatterns(agent.model, settings);
		if (resolved.length > 0) {
			model = resolved;
			modelSource = "frontmatter";
		}
	}

	if (model.length === 0) {
		const fallback =
			activeModelPattern?.trim() || fallbackModelPattern?.trim() || settings.getModelRole("default")?.trim() || "";
		const resolved = resolveConfiguredModelPatterns(fallback, settings);
		if (resolved.length > 0) {
			model = resolved;
			modelSource = "role-alias";
		}
	}

	// Thinking level: rule wins over frontmatter
	const thinkingLevel = winning?.thinkingLevel ?? agent.thinkingLevel;

	// Tools: rule replaces frontmatter (not appends)
	const tools = winning?.tools ?? agent.tools;

	return {
		model,
		thinkingLevel,
		tools,
		disabled,
		rule: winning,
		conflicts,
		modelSource,
		ruleSelector: winning?.selector.value,
		ruleSourcePath: winning?.sourcePath,
	};
}

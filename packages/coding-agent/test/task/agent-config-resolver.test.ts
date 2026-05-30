import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@spell/pi-agent-core";
import type { AgentRule, AgentRuleConflict } from "../../src/config/agents-kdl";
import { matchSelector, parseAgentSelector, selectorSpecificity } from "../../src/config/agents-kdl";
import { Settings } from "../../src/config/settings";
import {
	type EffectiveAgentConfig,
	type ResolveAgentConfigInput,
	resolveAgentEffectiveConfig,
} from "../../src/task/agent-config-resolver";
import type { AgentDefinition } from "../../src/task/types";

// ─────────────────────────────────────────────────────────────────────────────
// Inline test doubles
// ─────────────────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		name: "task",
		description: "test agent",
		systemPrompt: "you are a test agent",
		source: "bundled",
		...overrides,
	};
}

function makeRule(selectorStr: string, overrides: Partial<AgentRule> = {}): AgentRule {
	const selector = parseAgentSelector(selectorStr);
	if (!selector) throw new Error(`Invalid selector: ${selectorStr}`);
	return {
		selector,
		declarationOrder: 0,
		...overrides,
	};
}

function makeSettings(overrides: Record<string, unknown> = {}): Settings {
	return Settings.isolated(overrides);
}

// A mock resolver that implements the correct precedence contract.
// Used to verify expected behaviour while the real resolver is a placeholder.
// EXPAND in FEAT-646::impl (wave-4): replace calls to this mock with the real
// `resolveAgentEffectiveConfig` and remove `.todo` markers.
function mockResolveAgentEffectiveConfig(input: ResolveAgentConfigInput): EffectiveAgentConfig {
	const {
		agent,
		agentName,
		perCallTaskModel,
		perCallBatchModel,
		projectRules,
		userRules,
		settings,
		activeModelPattern,
	} = input;

	const disabledAgents: string[] = settings.get("task.disabledAgents") ?? [];
	const modelOverrides: Record<string, string> = settings.get("task.agentModelOverrides") ?? {};

	// Inline rule matching (real matchAgentRules is a placeholder until FEAT-644::impl)
	function findBestRule(rules: AgentRule[]) {
		const matched = rules.filter(r => matchSelector(agentName, r.selector));
		if (matched.length === 0)
			return { winning: undefined as AgentRule | undefined, conflicts: [] as AgentRuleConflict[] };

		// Sort by specificity descending, then declarationOrder ascending
		matched.sort((a, b) => {
			const specDiff = selectorSpecificity(b.selector) - selectorSpecificity(a.selector);
			if (specDiff !== 0) return specDiff;
			return a.declarationOrder - b.declarationOrder;
		});

		const highest = selectorSpecificity(matched[0].selector);
		const tied = matched.filter(r => selectorSpecificity(r.selector) === highest);

		if (tied.length === 1) {
			return { winning: tied[0], conflicts: [] };
		}

		return {
			winning: undefined,
			conflicts: [{ agentName, selectors: tied.map(r => r.selector.value) }] as AgentRuleConflict[],
		};
	}

	const projectMatch = findBestRule(projectRules);
	const userMatch = findBestRule(userRules);

	// Project rules win over user rules
	let winning: AgentRule | undefined;
	const conflicts: AgentRuleConflict[] = [...projectMatch.conflicts, ...userMatch.conflicts];
	if (projectMatch.winning) {
		winning = projectMatch.winning;
	} else if (userMatch.winning) {
		winning = userMatch.winning;
	}

	// Precedence chain for model
	let model: string[] = [];
	let modelSource: EffectiveAgentConfig["modelSource"] = "default";

	if (perCallTaskModel && perCallTaskModel.trim() !== "") {
		model = [perCallTaskModel];
		modelSource = "per-call";
	} else if (perCallBatchModel && perCallBatchModel.trim() !== "") {
		model = [perCallBatchModel];
		modelSource = "per-call";
	} else if (winning?.model && winning.model.length > 0) {
		model = winning.model;
		modelSource = "rule";
	} else if (modelOverrides[agentName]) {
		model = [modelOverrides[agentName]];
		modelSource = "settings";
	} else if (agent.model && agent.model.length > 0) {
		model = agent.model;
		modelSource = "frontmatter";
	} else if (activeModelPattern) {
		model = [activeModelPattern];
		modelSource = "role-alias";
	}

	// Disabled
	const disabled = winning?.disabled === true || disabledAgents.includes(agentName);

	// Tools: rule replaces frontmatter, not appends
	const tools = winning?.tools ?? agent.tools;

	// Thinking level: rule overrides frontmatter
	const thinkingLevel = winning?.thinkingLevel ?? agent.thinkingLevel;

	return {
		model,
		thinkingLevel,
		tools,
		disabled,
		conflicts,
		modelSource,
		rule: winning,
		ruleSelector: winning?.selector.value,
		ruleSourcePath: winning?.sourcePath,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Contract verification against mock resolver
// ─────────────────────────────────────────────────────────────────────────────

describe("agent-config-resolver contract (mock)", () => {
	test("per-task model wins over per-batch model", () => {
		const result = mockResolveAgentEffectiveConfig({
			agent: makeAgent(),
			agentName: "task",
			perCallTaskModel: "openai/gpt-4o",
			perCallBatchModel: "openai/gpt-3.5-turbo",
			projectRules: [],
			userRules: [],
			settings: makeSettings(),
		});
		expect(result.model).toEqual(["openai/gpt-4o"]);
		expect(result.modelSource).toBe("per-call");
	});

	test("per-batch model wins over project rule", () => {
		const result = mockResolveAgentEffectiveConfig({
			agent: makeAgent(),
			agentName: "task",
			perCallBatchModel: "openai/gpt-4o",
			projectRules: [makeRule("task", { model: ["anthropic/claude-3"] })],
			userRules: [],
			settings: makeSettings(),
		});
		expect(result.model).toEqual(["openai/gpt-4o"]);
		expect(result.modelSource).toBe("per-call");
	});

	test("project rule wins over user rule", () => {
		const result = mockResolveAgentEffectiveConfig({
			agent: makeAgent(),
			agentName: "task",
			projectRules: [makeRule("task", { model: ["openai/gpt-4o"] })],
			userRules: [makeRule("task", { model: ["anthropic/claude-3"] })],
			settings: makeSettings(),
		});
		expect(result.model).toEqual(["openai/gpt-4o"]);
		expect(result.modelSource).toBe("rule");
	});

	test("user rule wins over settings override", () => {
		const result = mockResolveAgentEffectiveConfig({
			agent: makeAgent(),
			agentName: "task",
			userRules: [makeRule("task", { model: ["openai/gpt-4o"] })],
			projectRules: [],
			settings: makeSettings({
				"task.agentModelOverrides": { task: "anthropic/claude-3" },
			}),
		});
		expect(result.model).toEqual(["openai/gpt-4o"]);
		expect(result.modelSource).toBe("rule");
	});

	test("settings override wins over frontmatter model", () => {
		const result = mockResolveAgentEffectiveConfig({
			agent: makeAgent({ model: ["anthropic/claude-3"] }),
			agentName: "task",
			projectRules: [],
			userRules: [],
			settings: makeSettings({
				"task.agentModelOverrides": { task: "openai/gpt-4o" },
			}),
		});
		expect(result.model).toEqual(["openai/gpt-4o"]);
		expect(result.modelSource).toBe("settings");
	});

	test("frontmatter model wins over default / active model", () => {
		const result = mockResolveAgentEffectiveConfig({
			agent: makeAgent({ model: ["anthropic/claude-3"] }),
			agentName: "task",
			projectRules: [],
			userRules: [],
			settings: makeSettings(),
			activeModelPattern: "openai/gpt-4o",
		});
		expect(result.model).toEqual(["anthropic/claude-3"]);
		expect(result.modelSource).toBe("frontmatter");
	});

	test("falls back to active model pattern when nothing else is set", () => {
		const result = mockResolveAgentEffectiveConfig({
			agent: makeAgent(),
			agentName: "task",
			projectRules: [],
			userRules: [],
			settings: makeSettings(),
			activeModelPattern: "openai/gpt-4o",
		});
		expect(result.model).toEqual(["openai/gpt-4o"]);
		expect(result.modelSource).toBe("role-alias");
	});

	test("empty per-task model string is treated as undefined", () => {
		const result = mockResolveAgentEffectiveConfig({
			agent: makeAgent(),
			agentName: "task",
			perCallTaskModel: "",
			perCallBatchModel: "openai/gpt-4o",
			projectRules: [],
			userRules: [],
			settings: makeSettings(),
		});
		expect(result.model).toEqual(["openai/gpt-4o"]);
		expect(result.modelSource).toBe("per-call");
	});

	test("rule disabled flag takes effect", () => {
		const result = mockResolveAgentEffectiveConfig({
			agent: makeAgent(),
			agentName: "task",
			projectRules: [makeRule("task", { disabled: true })],
			userRules: [],
			settings: makeSettings(),
		});
		expect(result.disabled).toBe(true);
	});

	test("settings disabledAgents still disables agent", () => {
		const result = mockResolveAgentEffectiveConfig({
			agent: makeAgent(),
			agentName: "quick_task",
			projectRules: [],
			userRules: [],
			settings: makeSettings({
				"task.disabledAgents": ["quick_task"],
			}),
		});
		expect(result.disabled).toBe(true);
	});

	test("rule tools replace frontmatter tools, not append", () => {
		const result = mockResolveAgentEffectiveConfig({
			agent: makeAgent({ tools: ["read", "write"] }),
			agentName: "task",
			projectRules: [makeRule("task", { tools: ["submit_result"] })],
			userRules: [],
			settings: makeSettings(),
		});
		expect(result.tools).toEqual(["submit_result"]);
	});

	test("rule thinkingLevel overrides frontmatter thinkingLevel", () => {
		const result = mockResolveAgentEffectiveConfig({
			agent: makeAgent({ thinkingLevel: ThinkingLevel.Low }),
			agentName: "task",
			projectRules: [makeRule("task", { thinkingLevel: ThinkingLevel.High })],
			userRules: [],
			settings: makeSettings(),
		});
		expect(result.thinkingLevel).toBe(ThinkingLevel.High);
	});

	test("catch-all rule * applies as fallback", () => {
		const result = mockResolveAgentEffectiveConfig({
			agent: makeAgent(),
			agentName: "task",
			projectRules: [makeRule("*", { model: ["openai/gpt-4o-mini"] })],
			userRules: [],
			settings: makeSettings(),
		});
		expect(result.model).toEqual(["openai/gpt-4o-mini"]);
		expect(result.modelSource).toBe("rule");
	});

	test("conflicts from rule matching are propagated", () => {
		const result = mockResolveAgentEffectiveConfig({
			agent: makeAgent(),
			agentName: "task",
			projectRules: [
				makeRule("task", { model: ["openai/gpt-4o"], declarationOrder: 0 }),
				makeRule("task", { model: ["openai/gpt-4o-mini"], declarationOrder: 1 }),
			],
			userRules: [],
			settings: makeSettings(),
		});
		// Two exact selectors for the same agent → same specificity tie → conflict
		expect(result.conflicts.length).toBeGreaterThan(0);
		expect(result.conflicts[0].selectors).toContain("task");
	});

	test("no rules falls through to frontmatter values", () => {
		const result = mockResolveAgentEffectiveConfig({
			agent: makeAgent({ model: ["anthropic/claude-3"], thinkingLevel: ThinkingLevel.Medium, tools: ["read"] }),
			agentName: "task",
			projectRules: [],
			userRules: [],
			settings: makeSettings(),
		});
		expect(result.model).toEqual(["anthropic/claude-3"]);
		expect(result.thinkingLevel).toBe(ThinkingLevel.Medium);
		expect(result.tools).toEqual(["read"]);
		expect(result.modelSource).toBe("frontmatter");
	});

	test("all override sources empty returns frontmatter values", () => {
		const result = mockResolveAgentEffectiveConfig({
			agent: makeAgent({ model: ["openai/gpt-4o"], thinkingLevel: ThinkingLevel.High }),
			agentName: "task",
			projectRules: [],
			userRules: [],
			settings: makeSettings(),
		});
		expect(result.model).toEqual(["openai/gpt-4o"]);
		expect(result.thinkingLevel).toBe(ThinkingLevel.High);
		expect(result.modelSource).toBe("frontmatter");
	});

	test("frontmatter model can be a string[] fallback chain", () => {
		const result = mockResolveAgentEffectiveConfig({
			agent: makeAgent({ model: ["openai/gpt-4o", "anthropic/claude-3", "google/gemini-pro"] }),
			agentName: "task",
			projectRules: [],
			userRules: [],
			settings: makeSettings(),
		});
		expect(result.model).toEqual(["openai/gpt-4o", "anthropic/claude-3", "google/gemini-pro"]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Real resolver — placeholder until FEAT-646::impl (wave-4)
// ─────────────────────────────────────────────────────────────────────────────

describe("agent-config-resolver (real function)", () => {
	test.todo("per-task model wins over per-batch model — EXPAND in FEAT-646::impl", () => {
		const result = resolveAgentEffectiveConfig({
			agent: makeAgent(),
			agentName: "task",
			perCallTaskModel: "openai/gpt-4o",
			perCallBatchModel: "openai/gpt-3.5-turbo",
			projectRules: [],
			userRules: [],
			settings: makeSettings(),
		});
		expect(result.model).toEqual(["openai/gpt-4o"]);
		expect(result.modelSource).toBe("per-call");
	});

	test.todo("per-batch model wins over project rule — EXPAND in FEAT-646::impl", () => {
		const result = resolveAgentEffectiveConfig({
			agent: makeAgent(),
			agentName: "task",
			perCallBatchModel: "openai/gpt-4o",
			projectRules: [makeRule("task", { model: ["anthropic/claude-3"] })],
			userRules: [],
			settings: makeSettings(),
		});
		expect(result.model).toEqual(["openai/gpt-4o"]);
		expect(result.modelSource).toBe("per-call");
	});

	test.todo("project rule wins over user rule — EXPAND in FEAT-646::impl", () => {
		const result = resolveAgentEffectiveConfig({
			agent: makeAgent(),
			agentName: "task",
			projectRules: [makeRule("task", { model: ["openai/gpt-4o"] })],
			userRules: [makeRule("task", { model: ["anthropic/claude-3"] })],
			settings: makeSettings(),
		});
		expect(result.model).toEqual(["openai/gpt-4o"]);
		expect(result.modelSource).toBe("rule");
	});

	test.todo("user rule wins over settings override — EXPAND in FEAT-646::impl", () => {
		const result = resolveAgentEffectiveConfig({
			agent: makeAgent(),
			agentName: "task",
			userRules: [makeRule("task", { model: ["openai/gpt-4o"] })],
			projectRules: [],
			settings: makeSettings({
				"task.agentModelOverrides": { task: "anthropic/claude-3" },
			}),
		});
		expect(result.model).toEqual(["openai/gpt-4o"]);
		expect(result.modelSource).toBe("rule");
	});

	test.todo("settings override wins over frontmatter model — EXPAND in FEAT-646::impl", () => {
		const result = resolveAgentEffectiveConfig({
			agent: makeAgent({ model: ["anthropic/claude-3"] }),
			agentName: "task",
			projectRules: [],
			userRules: [],
			settings: makeSettings({
				"task.agentModelOverrides": { task: "openai/gpt-4o" },
			}),
		});
		expect(result.model).toEqual(["openai/gpt-4o"]);
		expect(result.modelSource).toBe("settings");
	});

	test.todo("frontmatter model wins over default — EXPAND in FEAT-646::impl", () => {
		const result = resolveAgentEffectiveConfig({
			agent: makeAgent({ model: ["anthropic/claude-3"] }),
			agentName: "task",
			projectRules: [],
			userRules: [],
			settings: makeSettings(),
			activeModelPattern: "openai/gpt-4o",
		});
		expect(result.model).toEqual(["anthropic/claude-3"]);
		expect(result.modelSource).toBe("frontmatter");
	});

	test.todo("rule disabled flag takes effect — EXPAND in FEAT-646::impl", () => {
		const result = resolveAgentEffectiveConfig({
			agent: makeAgent(),
			agentName: "task",
			projectRules: [makeRule("task", { disabled: true })],
			userRules: [],
			settings: makeSettings(),
		});
		expect(result.disabled).toBe(true);
	});

	test.todo("settings disabledAgents still disables agent — EXPAND in FEAT-646::impl", () => {
		const result = resolveAgentEffectiveConfig({
			agent: makeAgent(),
			agentName: "quick_task",
			projectRules: [],
			userRules: [],
			settings: makeSettings({
				"task.disabledAgents": ["quick_task"],
			}),
		});
		expect(result.disabled).toBe(true);
	});

	test.todo("rule tools replace frontmatter tools, not append — EXPAND in FEAT-646::impl", () => {
		const result = resolveAgentEffectiveConfig({
			agent: makeAgent({ tools: ["read", "write"] }),
			agentName: "task",
			projectRules: [makeRule("task", { tools: ["submit_result"] })],
			userRules: [],
			settings: makeSettings(),
		});
		expect(result.tools).toEqual(["submit_result"]);
	});

	test.todo("rule thinkingLevel overrides frontmatter — EXPAND in FEAT-646::impl", () => {
		const result = resolveAgentEffectiveConfig({
			agent: makeAgent({ thinkingLevel: ThinkingLevel.Low }),
			agentName: "task",
			projectRules: [makeRule("task", { thinkingLevel: ThinkingLevel.High })],
			userRules: [],
			settings: makeSettings(),
		});
		expect(result.thinkingLevel).toBe(ThinkingLevel.High);
	});

	test.todo("empty per-task model string is treated as undefined — EXPAND in FEAT-646::impl", () => {
		const result = resolveAgentEffectiveConfig({
			agent: makeAgent(),
			agentName: "task",
			perCallTaskModel: "",
			perCallBatchModel: "openai/gpt-4o",
			projectRules: [],
			userRules: [],
			settings: makeSettings(),
		});
		expect(result.model).toEqual(["openai/gpt-4o"]);
		expect(result.modelSource).toBe("per-call");
	});

	test.todo("catch-all rule * applies as fallback — EXPAND in FEAT-646::impl", () => {
		const result = resolveAgentEffectiveConfig({
			agent: makeAgent(),
			agentName: "task",
			projectRules: [makeRule("*", { model: ["openai/gpt-4o-mini"] })],
			userRules: [],
			settings: makeSettings(),
		});
		expect(result.model).toEqual(["openai/gpt-4o-mini"]);
		expect(result.modelSource).toBe("rule");
	});

	test.todo("conflicts from rule matching are propagated — EXPAND in FEAT-646::impl", () => {
		const result = resolveAgentEffectiveConfig({
			agent: makeAgent(),
			agentName: "task",
			projectRules: [
				makeRule("task", { model: ["openai/gpt-4o"], declarationOrder: 0 }),
				makeRule("task", { model: ["openai/gpt-4o-mini"], declarationOrder: 1 }),
			],
			userRules: [],
			settings: makeSettings(),
		});
		expect(result.conflicts.length).toBeGreaterThan(0);
		expect(result.conflicts[0].selectors).toContain("task");
	});

	test.todo("no rules falls through to frontmatter values — EXPAND in FEAT-646::impl", () => {
		const result = resolveAgentEffectiveConfig({
			agent: makeAgent({ model: ["anthropic/claude-3"], thinkingLevel: ThinkingLevel.Medium, tools: ["read"] }),
			agentName: "task",
			projectRules: [],
			userRules: [],
			settings: makeSettings(),
		});
		expect(result.model).toEqual(["anthropic/claude-3"]);
		expect(result.thinkingLevel).toBe(ThinkingLevel.Medium);
		expect(result.tools).toEqual(["read"]);
		expect(result.modelSource).toBe("frontmatter");
	});

	test.todo("all override sources empty returns frontmatter values — EXPAND in FEAT-646::impl", () => {
		const result = resolveAgentEffectiveConfig({
			agent: makeAgent({ model: ["openai/gpt-4o"], thinkingLevel: ThinkingLevel.High }),
			agentName: "task",
			projectRules: [],
			userRules: [],
			settings: makeSettings(),
		});
		expect(result.model).toEqual(["openai/gpt-4o"]);
		expect(result.thinkingLevel).toBe(ThinkingLevel.High);
		expect(result.modelSource).toBe("frontmatter");
	});

	test.todo("frontmatter model can be a string[] fallback chain — EXPAND in FEAT-646::impl", () => {
		const result = resolveAgentEffectiveConfig({
			agent: makeAgent({ model: ["openai/gpt-4o", "anthropic/claude-3", "google/gemini-pro"] }),
			agentName: "task",
			projectRules: [],
			userRules: [],
			settings: makeSettings(),
		});
		expect(result.model).toEqual(["openai/gpt-4o", "anthropic/claude-3", "google/gemini-pro"]);
	});

	test.todo("missing settings does not crash — EXPAND in FEAT-646::impl", () => {
		const result = resolveAgentEffectiveConfig({
			agent: makeAgent(),
			agentName: "task",
			projectRules: [],
			userRules: [],
			settings: makeSettings(),
		});
		expect(result.model).toBeDefined();
		expect(result.disabled).toBe(false);
	});
});

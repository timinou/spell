import type { Node } from "@bgotink/kdl";
import type { ThinkingLevel } from "@spell/pi-agent-core";
import { logger } from "@spell/pi-utils";
import { parseThinkingLevel } from "../thinking";
import { getBooleanProperty, getChildNode, getChildNodes, getStringArgument, getStringArguments } from "./kdl-helpers";

export interface AgentRuleSelector {
	kind: "exact" | "prefixGlob" | "suffixGlob" | "infixGlob" | "wildcard";
	value: string;
	pattern: RegExp;
}

export interface AgentRule {
	selector: AgentRuleSelector;
	model?: string[];
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	disabled?: boolean;
	sourcePath?: string;
	declarationOrder: number;
}

export interface AgentRuleConflict {
	agentName: string;
	selectors: string[];
}

export interface AgentRulesConfig {
	rules: AgentRule[];
	conflicts: AgentRuleConflict[];
}

/**
 * Compile a glob selector string into a RegExp for matching.
 * Escapes regex metacharacters except * → .* and ? → .
 * Anchored with ^...$
 */
export function compileGlob(selector: string): RegExp {
	let pattern = "";
	for (const ch of selector) {
		switch (ch) {
			case "*":
				pattern += ".*";
				break;
			case "?":
				pattern += ".";
				break;
			case ".":
			case "+":
			case "^":
			case "$":
			case "{":
			case "}":
			case "(":
			case ")":
			case "|":
			case "[":
			case "]":
			case "\\":
				pattern += `\\${ch}`;
				break;
			default:
				pattern += ch;
		}
	}
	return new RegExp(`^${pattern}$`);
}

/**
 * Parse a raw selector string into an AgentRuleSelector.
 * Auto-detects glob vs exact based on presence of * or ?.
 * Returns undefined for empty or whitespace-only strings.
 */
export function parseAgentSelector(raw: string): AgentRuleSelector | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;

	const hasGlob = trimmed.includes("*") || trimmed.includes("?");
	if (!hasGlob) {
		return { kind: "exact", value: trimmed, pattern: compileGlob(trimmed) };
	}

	if (trimmed === "*") {
		return { kind: "wildcard", value: "*", pattern: compileGlob("*") };
	}

	const starIndex = trimmed.indexOf("*");
	const questionIndex = trimmed.indexOf("?");
	const firstGlob =
		starIndex === -1 ? questionIndex : questionIndex === -1 ? starIndex : Math.min(starIndex, questionIndex);

	if (firstGlob === 0) {
		// Starts with glob char -* or -?
		if (trimmed.endsWith("*")) {
			return { kind: "infixGlob", value: trimmed, pattern: compileGlob(trimmed) };
		}
		return { kind: "suffixGlob", value: trimmed, pattern: compileGlob(trimmed) };
	}

	if (trimmed.endsWith("*")) {
		return { kind: "prefixGlob", value: trimmed, pattern: compileGlob(trimmed) };
	}

	return { kind: "infixGlob", value: trimmed, pattern: compileGlob(trimmed) };
}

/**
 * Specificity score: higher = more specific.
 * exact=4, prefixGlob=3, suffixGlob=2, infixGlob=1, wildcard=0
 */
export function selectorSpecificity(s: AgentRuleSelector): number {
	switch (s.kind) {
		case "exact":
			return 4;
		case "prefixGlob":
			return 3;
		case "suffixGlob":
			return 2;
		case "infixGlob":
			return 1;
		case "wildcard":
			return 0;
	}
}

/**
 * Test if an agent name matches a compiled selector pattern.
 */
export function matchSelector(agentName: string, selector: AgentRuleSelector): boolean {
	return selector.pattern.test(agentName);
}

/**
 * Parse the `agents { ... }` block from a spell.kdl node.
 * Returns a config with rules and any same-specificity conflicts detected.
 * Placeholder — full implementation in FEAT-644::parser.
 */
export function parseAgentsBlock(node: unknown, sourcePath?: string): AgentRulesConfig {
	const rules: AgentRule[] = [];
	const children = getChildNodes(node as unknown as Node);

	for (let i = 0; i < children.length; i++) {
		const child = children[i];
		if (child.getName() !== "rule") continue;

		const rawSelector = getStringArgument(child, 0);
		const selector = parseAgentSelector(rawSelector ?? "");
		if (!selector) {
			logger.warn("agents-kdl: rule with empty or invalid selector, skipping", {
				sourcePath,
			});
			continue;
		}

		const disabled = getBooleanProperty(child, "disabled");
		let model: string[] | undefined;
		let thinkingLevel: ThinkingLevel | undefined;
		let tools: string[] | undefined;

		// Read child nodes for model, thinking-level, tools
		const modelNode = getChildNode(child, "model");
		if (modelNode) {
			const args = getStringArguments(modelNode);
			if (args.length > 0) model = args;
		}

		const thinkingNode = getChildNode(child, "thinking-level");
		if (thinkingNode) {
			const raw = getStringArgument(thinkingNode, 0);
			if (raw) {
				const parsed = parseThinkingLevel(raw);
				if (parsed) thinkingLevel = parsed;
			}
		}

		const toolsNode = getChildNode(child, "tools");
		if (toolsNode) {
			const toolArgs = getStringArguments(toolsNode);
			if (toolArgs.length > 0) tools = toolArgs;
		}

		rules.push({
			selector,
			model,
			thinkingLevel,
			tools,
			disabled,
			sourcePath,
			declarationOrder: i,
		});
	}

	return { rules, conflicts: [] };
}

/**
 * Find the winning rule for an agent name, resolving specificity and tie-breaking.
 * Placeholder — full implementation in FEAT-644::parser.
 */
export function matchAgentRules(
	agentName: string,
	rules: AgentRule[],
): { winning?: AgentRule; conflicts: AgentRuleConflict[] } {
	// Filter rules whose selector pattern matches the agent name
	const matching = rules.filter(r => matchSelector(agentName, r.selector));
	if (matching.length === 0) return { winning: undefined, conflicts: [] };

	// Sort by specificity desc, then declarationOrder desc (last-declared wins ties)
	const sorted = [...matching].sort((a, b) => {
		const specDiff = selectorSpecificity(b.selector) - selectorSpecificity(a.selector);
		if (specDiff !== 0) return specDiff;
		return b.declarationOrder - a.declarationOrder;
	});

	const winning = sorted[0];
	const topSpecificity = selectorSpecificity(winning.selector);

	// Detect same-specificity conflicts (excluding exact duplicates of the same selector)
	const sameSpec = sorted.filter(r => selectorSpecificity(r.selector) === topSpecificity);
	const conflicts: AgentRuleConflict[] = [];

	if (sameSpec.length > 1) {
		conflicts.push({
			agentName,
			selectors: sameSpec.map(r => r.selector.value),
		});
		logger.warn("agents-kdl: ambiguous agent rules — same specificity, last-declared wins", {
			agentName,
			selectors: sameSpec.map(r => r.selector.value),
			winning: winning.selector.value,
		});
	}

	return { winning, conflicts };
}

/**
 * KDL parser for the unified `discipline` block (FEAT-816).
 *
 * Grammar:
 * ```kdl
 * discipline "name" {
 *     description "…"
 *     command "/name"                       // optional; implies manual trigger
 *     on manual                             // or: on tool="x" | on layer="x" | on auto
 *     read-only #true
 *     inject cadence="once" {               // cadence: once | carry (default carry)
 *         context "…"
 *         instructions "…"
 *         focus-areas "…"
 *     }
 *     verify {
 *         swarm 3 criteria="…"              // N parallel reviewers
 *         cmd "bun test"
 *         review "criteria prose"
 *         commit #true
 *         artifact "path"
 *     }
 *     tools { allow "find" "get" ; deny "bash" }
 * }
 * ```
 *
 * `mode` and `policy` blocks are NOT parsed here — they are parsed by their own
 * legacy parsers and desugared via {@link modeToDiscipline}/{@link policyToDiscipline}.
 * This parser handles only first-class `discipline` blocks.
 */

import type { Document, Node } from "@bgotink/kdl";

import type { ModeConfigSections } from "../capability/mode";
import type {
	Discipline,
	DisciplineCadence,
	DisciplineInject,
	DisciplineTools,
	DisciplineTrigger,
	DisciplineVerify,
} from "./discipline";
import { hasInject, hasVerify } from "./discipline";
import {
	getBooleanArgument,
	getChildNode,
	getNumberArgument,
	getStringArgument,
	getStringArguments,
	getStringProperty,
} from "./kdl-helpers";

/**
 * Parse the `on` trigger node. Accepts an argument form (`on manual`, `on auto`)
 * or a property form (`on tool="x"`, `on layer="x"`). Property form wins.
 * Defaults to `manual` when the node is malformed.
 */
/** Sink for non-fatal parser diagnostics. Kept callback-based so the pure parser
 *  stays free of the logger (and its native-coupled dependency graph); the
 *  config layer supplies the real logger. */
export type DisciplineWarn = (message: string) => void;

function parseTrigger(node: Node, disciplineName: string, warn: DisciplineWarn): DisciplineTrigger {
	const tool = getStringProperty(node, "tool");
	if (tool) return { kind: "tool", tool };
	const layer = getStringProperty(node, "layer");
	if (layer) return { kind: "layer", layer };
	const arg = getStringArgument(node);
	if (arg === "auto") return { kind: "auto" };
	if (arg === "manual") return { kind: "manual" };
	if (arg === "tool" || arg === "layer") {
		// `on tool "x"` (arg+arg) form
		const second = getStringArgument(node, 1);
		if (second) return arg === "tool" ? { kind: "tool", tool: second } : { kind: "layer", layer: second };
		// `on tool` / `on layer` with no value: an authoring mistake — a tool/layer
		// discipline that can never fire. Warn instead of silently making it manual.
		warn(
			`discipline "${disciplineName}": \`on ${arg}\` has no value — expected \`on ${arg}="…"\`. ` +
				"Falling back to manual; this discipline will not fire on its intended trigger.",
		);
		return { kind: "manual" };
	}
	if (arg !== undefined && arg.length > 0) {
		warn(`discipline "${disciplineName}": unknown trigger \`on ${arg}\` — falling back to manual.`);
	}
	return { kind: "manual" };
}

/** Parse the `inject { … }` block into sections + cadence. */
function parseInject(node: Node): DisciplineInject | undefined {
	const cadenceRaw = getStringProperty(node, "cadence") ?? getStringArgument(node);
	const cadence: DisciplineCadence = cadenceRaw === "once" ? "once" : "carry";

	const sections: ModeConfigSections = { custom: {} };
	const context = getChildNode(node, "context");
	if (context) sections.context = getStringArgument(context)?.trimEnd();
	const instructions = getChildNode(node, "instructions");
	if (instructions) sections.instructions = getStringArgument(instructions)?.trimEnd();
	const focusAreas = getChildNode(node, "focus-areas");
	if (focusAreas) sections.focusAreas = getStringArgument(focusAreas)?.trimEnd();

	const inject: DisciplineInject = { cadence, sections };
	return hasInject(inject) ? inject : undefined;
}

/** Parse the `verify { … }` block, including the `swarm` gate. */
function parseVerify(node: Node): DisciplineVerify | undefined {
	const verify: DisciplineVerify = {};
	for (const child of node.children?.nodes ?? []) {
		switch (child.getName()) {
			case "swarm": {
				const count = getNumberArgument(child);
				if (count !== undefined && Number.isInteger(count) && count > 0) {
					verify.swarm = { count };
					const criteria = getStringProperty(child, "criteria");
					if (criteria) verify.swarm.criteria = criteria;
				}
				break;
			}
			case "cmd":
			case "verify-cmd": {
				const cmd = getStringArgument(child);
				if (cmd !== undefined) verify.cmd = cmd;
				break;
			}
			case "review":
			case "verify-review": {
				const review = getStringArgument(child);
				if (review !== undefined) verify.review = review;
				break;
			}
			case "commit":
			case "verify-commit": {
				const commit = getBooleanArgument(child);
				if (commit !== undefined) verify.commit = commit;
				break;
			}
			case "artifact":
			case "verify-artifact": {
				const artifact = getStringArgument(child);
				if (artifact !== undefined) verify.artifact = artifact;
				break;
			}
		}
	}
	return hasVerify(verify) ? verify : undefined;
}

/** Parse a `tools { allow … ; deny … }` block. */
function parseTools(node: Node): DisciplineTools | undefined {
	const allowNode = getChildNode(node, "allow");
	const denyNode = getChildNode(node, "deny");
	const allow = allowNode ? getStringArguments(allowNode) : [];
	const deny = denyNode ? getStringArguments(denyNode) : [];
	if (allow.length === 0 && deny.length === 0) return undefined;
	const tools: DisciplineTools = {};
	if (allow.length > 0) tools.allow = allow;
	if (deny.length > 0) tools.deny = deny;
	return tools;
}

/** Parse a single `discipline "name" { … }` node. */
const noopWarn: DisciplineWarn = () => {};

export function parseDisciplineNode(node: Node, warn: DisciplineWarn = noopWarn): Discipline | undefined {
	const name = getStringArgument(node);
	if (!name) return undefined;

	const descriptionNode = getChildNode(node, "description");
	const commandNode = getChildNode(node, "command");
	const onNode = getChildNode(node, "on");
	const readOnlyNode = getChildNode(node, "read-only");
	const injectNode = getChildNode(node, "inject");
	const verifyNode = getChildNode(node, "verify");
	const guardNode = getChildNode(node, "guard");
	const toolsNode = getChildNode(node, "tools");

	const command = commandNode ? getStringArgument(commandNode) : undefined;
	// A `command` with no explicit `on` implies a manual (role-style) trigger.
	const on: DisciplineTrigger = onNode ? parseTrigger(onNode, name, warn) : { kind: "manual" };

	const discipline: Discipline = { name, on, origin: "discipline" };
	if (descriptionNode) discipline.description = getStringArgument(descriptionNode);
	if (command !== undefined) discipline.command = command;
	if (readOnlyNode) {
		const ro = getBooleanArgument(readOnlyNode);
		if (ro !== undefined) discipline.readOnly = ro;
	}
	if (injectNode) {
		const inject = parseInject(injectNode);
		if (inject) discipline.inject = inject;
	}
	if (verifyNode) {
		const verify = parseVerify(verifyNode);
		if (verify) discipline.verify = verify;
	}
	if (guardNode) {
		const g = getStringArgument(guardNode);
		if (g === "open-work") {
			discipline.guard = g;
		} else {
			warn(`discipline "${name}": unknown guard "${g}" — ignored.`);
		}
	}
	if (toolsNode) {
		const tools = parseTools(toolsNode);
		if (tools) discipline.tools = tools;
	}
	return discipline;
}

/** Collect all first-class `discipline` blocks from a KDL document. */
export function parseDisciplineBlocks(doc: Document, warn: DisciplineWarn = noopWarn): Discipline[] {
	const disciplines: Discipline[] = [];
	for (const node of doc.findNodesByName("discipline")) {
		const parsed = parseDisciplineNode(node, warn);
		if (parsed) disciplines.push(parsed);
	}
	return disciplines;
}

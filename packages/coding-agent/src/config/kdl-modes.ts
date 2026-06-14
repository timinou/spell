import type { Document, Node } from "@bgotink/kdl";

import type { ModeConfigFrontmatter, ModeConfigSections } from "../capability/mode";
import {
	getBooleanArgument,
	getChildNode,
	getStringArgument,
	getStringArguments,
	getStringProperty,
} from "./kdl-helpers";

export interface ParsedModeBlock {
	name: string;
	config: Record<string, unknown>;
	/** Prose sections authored inline in the KDL block (context/instructions/focus-areas). */
	sections: ModeConfigSections;
}

function parseToolsNode(node: Node): ModeConfigFrontmatter["tools"] | undefined {
	const allow = getChildNode(node, "allow") ? getStringArguments(getChildNode(node, "allow")!) : [];
	const deny = getChildNode(node, "deny") ? getStringArguments(getChildNode(node, "deny")!) : [];
	if (allow.length === 0 && deny.length === 0) return undefined;

	const tools: NonNullable<ModeConfigFrontmatter["tools"]> = {};
	if (allow.length > 0) tools.allow = allow;
	if (deny.length > 0) tools.deny = deny;
	return tools;
}

function parseModeNode(node: Node): ParsedModeBlock | undefined {
	const name = getStringArgument(node);
	if (!name) return undefined;

	const config: Record<string, unknown> = {};
	const extendsValue = getStringProperty(node, "extends");
	if (extendsValue !== undefined) config.extends = extendsValue;

	const commandNode = getChildNode(node, "command");
	const command = commandNode ? getStringArgument(commandNode) : undefined;
	if (command !== undefined) config.command = command;

	const descriptionNode = getChildNode(node, "description");
	const description = descriptionNode ? getStringArgument(descriptionNode) : undefined;
	if (description !== undefined) config.description = description;

	const readOnlyNode = getChildNode(node, "read-only");
	const readOnly = readOnlyNode ? getBooleanArgument(readOnlyNode) : undefined;
	if (readOnly !== undefined) config.readOnly = readOnly;

	const contextPolicyNode = getChildNode(node, "context-policy");
	const contextPolicy = contextPolicyNode ? getStringArgument(contextPolicyNode) : undefined;
	if (contextPolicy !== undefined) config.contextPolicy = contextPolicy;

	// Prose lives inline in the KDL block (multiline `"""..."""` strings). No markdown sidecar.
	const sections: ModeConfigSections = { custom: {} };
	const contextNode = getChildNode(node, "context");
	const contextText = contextNode ? getStringArgument(contextNode) : undefined;
	if (contextText !== undefined) sections.context = contextText.trimEnd();
	const instructionsNode = getChildNode(node, "instructions");
	const instructionsText = instructionsNode ? getStringArgument(instructionsNode) : undefined;
	if (instructionsText !== undefined) sections.instructions = instructionsText.trimEnd();
	const focusAreasNode = getChildNode(node, "focus-areas");
	const focusAreasText = focusAreasNode ? getStringArgument(focusAreasNode) : undefined;
	if (focusAreasText !== undefined) sections.focusAreas = focusAreasText.trimEnd();

	const toolsNode = getChildNode(node, "tools");
	const tools = toolsNode ? parseToolsNode(toolsNode) : undefined;
	if (tools) config.tools = tools;

	return { name, config, sections };
}

export function parseModeBlocks(doc: Document): ParsedModeBlock[] {
	const modes: ParsedModeBlock[] = [];
	for (const node of doc.findNodesByName("mode")) {
		const parsed = parseModeNode(node);
		if (parsed) modes.push(parsed);
	}
	return modes;
}

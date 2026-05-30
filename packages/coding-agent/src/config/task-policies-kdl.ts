import type { Document, Node } from "@bgotink/kdl";
import { parse } from "@bgotink/kdl";
import { logger } from "@spell/pi-utils";
import { getBooleanArgument, getStringArgument, getStringProperty } from "./kdl-helpers";
import type { LayerDefinition, TaskPolicy, TaskPolicyConfig, TaskPolicyGates } from "./task-policies";

function parseLayerNode(node: Node): [string, LayerDefinition] | undefined {
	const name = getStringArgument(node);
	if (!name) return undefined;

	return [
		name,
		{
			description: getStringProperty(node, "description") ?? "",
		},
	];
}

function parsePolicyGates(policyNode: Node): { gates: TaskPolicyGates; description?: string; inject?: string } {
	const gates: TaskPolicyGates = {};
	let description: string | undefined;
	let inject: string | undefined;

	for (const childNode of policyNode.children?.nodes ?? []) {
		switch (childNode.getName()) {
			case "gate-commit": {
				const gateCommit = getBooleanArgument(childNode);
				if (gateCommit !== undefined) gates.gateCommit = gateCommit;
				break;
			}
			case "gate-cmd": {
				const gateCmd = getStringArgument(childNode);
				if (gateCmd !== undefined) gates.gateCmd = gateCmd;
				break;
			}
			case "gate-artifact": {
				const gateArtifact = getStringArgument(childNode);
				if (gateArtifact !== undefined) gates.gateArtifact = gateArtifact;
				break;
			}
			case "gate-llm": {
				const gateLlm = getStringArgument(childNode);
				if (gateLlm !== undefined) gates.gateLlm = gateLlm;
				break;
			}
			case "verify-cmd": {
				const verifyCmd = getStringArgument(childNode);
				if (verifyCmd !== undefined) gates.verifyCmd = verifyCmd;
				break;
			}
			case "inject": {
				inject = getStringArgument(childNode);
				break;
			}
			case "description": {
				description = getStringArgument(childNode);
				break;
			}
		}
	}

	return { gates, description, inject };
}

function parsePolicyNode(node: Node): TaskPolicy | undefined {
	const name = getStringArgument(node);
	if (!name) {
		logger.warn("task-policies: skipping policy without name");
		return undefined;
	}

	const layer = getStringProperty(node, "layer");
	if (!layer) {
		logger.warn("task-policies: skipping policy without valid match.layer", { name });
		return undefined;
	}

	const { gates, description, inject } = parsePolicyGates(node);
	return {
		name,
		description,
		match: { layer },
		gates,
		inject,
	};
}

export function parseTaskPoliciesKdl(kdlContent: string): TaskPolicyConfig | undefined {
	let document: Document;
	try {
		document = parse(kdlContent);
	} catch (error) {
		logger.warn("task-policies: KDL parse error", { error: error instanceof Error ? error.message : String(error) });
		return undefined;
	}

	const layers: Record<string, LayerDefinition> = {};
	const policies: TaskPolicy[] = [];

	for (const node of document.nodes) {
		switch (node.getName()) {
			case "layer": {
				const parsedLayer = parseLayerNode(node);
				if (!parsedLayer) break;
				const [name, layerDefinition] = parsedLayer;
				layers[name] = layerDefinition;
				break;
			}
			case "policy": {
				const policy = parsePolicyNode(node);
				if (policy) policies.push(policy);
				break;
			}
		}
	}

	return {
		version: 1,
		layers,
		policies,
	};
}

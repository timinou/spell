import type { Document, Node } from "@bgotink/kdl";
import { parse } from "@bgotink/kdl";
import { logger } from "@spell/pi-utils";
import { getBooleanArgument, getNumberArgument, getStringArgument, getStringProperty } from "./kdl-helpers";
import type { LayerDefinition, TaskPolicy, TaskPolicyConfig, TaskVerify } from "./task-policies";

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

function parsePolicyGates(policyNode: Node): { verify: TaskVerify; description?: string; inject?: string } {
	const verify: TaskVerify = {};
	let description: string | undefined;
	let inject: string | undefined;

	for (const childNode of policyNode.children?.nodes ?? []) {
		switch (childNode.getName()) {
			case "verify-commit":
			case "gate-commit": {
				const commit = getBooleanArgument(childNode);
				if (commit !== undefined) verify.commit = commit;
				break;
			}
			case "verify-cmd":
			case "gate-cmd": {
				const cmd = getStringArgument(childNode);
				if (cmd !== undefined) verify.cmd = cmd;
				break;
			}
			case "verify-artifact":
			case "gate-artifact": {
				const artifact = getStringArgument(childNode);
				if (artifact !== undefined) verify.artifact = artifact;
				break;
			}
			case "verify-review":
			case "gate-llm": {
				const review = getStringArgument(childNode);
				if (review !== undefined) verify.review = review;
				break;
			}
			case "verify-swarm":
			case "swarm": {
				const count = getNumberArgument(childNode);
				if (count !== undefined && count > 0) {
					verify.swarm = { count };
					const criteria = getStringProperty(childNode, "criteria");
					if (criteria) verify.swarm.criteria = criteria;
				}
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

	return { verify, description, inject };
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

	const { verify, description, inject } = parsePolicyGates(node);
	return {
		name,
		description,
		match: { layer },
		verify,
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

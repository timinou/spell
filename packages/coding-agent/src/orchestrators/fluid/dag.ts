import { CANVAS_OUTPUT_TYPES, type CanvasOutputType, type FluidPlan } from "./types";

interface TopologicalResult {
	order: string[];
	hasCycle: boolean;
}

export interface PlanValidationResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
}

const MAX_RECOMMENDED_AGENT_COUNT = 12;
const canvasOutputTypes = new Set<string>(CANVAS_OUTPUT_TYPES);

function isCanvasOutputType(value: string): value is CanvasOutputType {
	return canvasOutputTypes.has(value);
}

function runTopologicalSort(plan: FluidPlan): TopologicalResult {
	const inDegree = new Map<string, number>();
	const adjacency = new Map<string, string[]>();

	for (const node of plan.agents) {
		inDegree.set(node.id, node.dependsOn.length);
		adjacency.set(node.id, []);
	}

	for (const node of plan.agents) {
		for (const dep of node.dependsOn) {
			const edges = adjacency.get(dep);
			if (edges) {
				edges.push(node.id);
			}
		}
	}

	const queue: string[] = [];
	for (const [id, degree] of inDegree) {
		if (degree === 0) {
			queue.push(id);
		}
	}

	const order: string[] = [];
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) {
			continue;
		}
		order.push(current);

		const neighbors = adjacency.get(current);
		if (!neighbors) {
			continue;
		}

		for (const neighbor of neighbors) {
			const nextDegree = (inDegree.get(neighbor) ?? 0) - 1;
			inDegree.set(neighbor, nextDegree);
			if (nextDegree === 0) {
				queue.push(neighbor);
			}
		}
	}

	return { order, hasCycle: order.length !== plan.agents.length };
}

export function validatePlan(plan: FluidPlan): PlanValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];
	const ids = new Set<string>();
	const seenCanvasTitles = new Set<string>();
	const duplicateCanvasTitleWarnings = new Set<string>();

	if (plan.agents.length === 0) {
		errors.push("Plan must contain at least one agent");
	}
	if (plan.agents.length > MAX_RECOMMENDED_AGENT_COUNT) {
		warnings.push(
			`Plan has ${plan.agents.length} agents; this exceeds the recommended limit of ${MAX_RECOMMENDED_AGENT_COUNT}`,
		);
	}

	for (const node of plan.agents) {
		if (ids.has(node.id)) {
			errors.push(`Duplicate agent id: ${node.id}`);
			continue;
		}
		ids.add(node.id);
	}

	for (const node of plan.agents) {
		if (node.task.trim().length === 0) {
			errors.push(`Agent ${node.id} must have a non-empty task description`);
		}

		if (node.canvasOutput) {
			const canvasType = String(node.canvasOutput.type ?? "");
			if (!isCanvasOutputType(canvasType)) {
				errors.push(`Agent ${node.id} has invalid canvasOutput type: ${canvasType || "<empty>"}`);
			} else {
				const canvasTitle = String(node.canvasOutput.title ?? "").trim();
				if (canvasTitle.length > 0) {
					const titleKey = `${canvasType}::${canvasTitle.toLowerCase()}`;
					if (seenCanvasTitles.has(titleKey)) {
						const warning = `Duplicate canvasOutput title for type "${canvasType}": "${canvasTitle}"`;
						if (!duplicateCanvasTitleWarnings.has(warning)) {
							warnings.push(warning);
							duplicateCanvasTitleWarnings.add(warning);
						}
					} else {
						seenCanvasTitles.add(titleKey);
					}
				}
			}
		}
	}

	for (const node of plan.agents) {
		for (const dep of node.dependsOn) {
			if (!ids.has(dep)) {
				errors.push(`Agent ${node.id} depends on missing agent ${dep}`);
			}
			if (dep === node.id) {
				errors.push(`Agent ${node.id} cannot depend on itself`);
			}
		}
	}

	const entryCount = plan.agents.filter(node => node.dependsOn.length === 0).length;
	if (plan.agents.length > 0 && entryCount === 0) {
		errors.push("Plan must contain at least one entry-point agent with no dependencies");
	}

	if (errors.length === 0) {
		const topo = runTopologicalSort(plan);
		if (topo.hasCycle) {
			errors.push("Plan contains dependency cycles");
		}
	}

	return { valid: errors.length === 0, errors, warnings };
}

export function topologicalOrder(plan: FluidPlan): string[] {
	const topo = runTopologicalSort(plan);
	if (topo.hasCycle) {
		throw new Error("Cannot compute topological order for cyclic DAG");
	}
	return topo.order;
}

export function getReadyAgents(plan: FluidPlan, completed: Set<string>): string[] {
	const ready: string[] = [];
	for (const node of plan.agents) {
		if (node.dependsOn.length === 0 || node.dependsOn.every(dep => completed.has(dep))) {
			ready.push(node.id);
		}
	}
	return ready;
}

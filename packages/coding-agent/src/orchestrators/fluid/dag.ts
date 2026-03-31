import { CANVAS_OUTPUT_TYPES, type CanvasOutputType, type FluidAgentNode, type FluidPlan } from "./types";

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

/**
 * Split a FluidPlan into connected components using union-find.
 *
 * Each component is an independent sub-DAG that can be executed
 * by a separate coordinator. Single-component plans return `[plan]`
 * unchanged (backward compatible).
 */
export function splitIntoComponents(plan: FluidPlan): FluidPlan[] {
	if (plan.agents.length <= 1) return [plan];

	// Union-find: parent map + rank
	const parent = new Map<string, string>();
	const rank = new Map<string, number>();

	for (const node of plan.agents) {
		parent.set(node.id, node.id);
		rank.set(node.id, 0);
	}

	function find(x: string): string {
		let root = x;
		while (parent.get(root) !== root) {
			root = parent.get(root)!;
		}
		// Path compression
		let current = x;
		while (current !== root) {
			const next = parent.get(current)!;
			parent.set(current, root);
			current = next;
		}
		return root;
	}

	function union(a: string, b: string): void {
		const ra = find(a);
		const rb = find(b);
		if (ra === rb) return;
		const rankA = rank.get(ra) ?? 0;
		const rankB = rank.get(rb) ?? 0;
		if (rankA < rankB) {
			parent.set(ra, rb);
		} else if (rankA > rankB) {
			parent.set(rb, ra);
		} else {
			parent.set(rb, ra);
			rank.set(ra, rankA + 1);
		}
	}

	// Union nodes connected by dependency edges (undirected for component detection)
	for (const node of plan.agents) {
		for (const dep of node.dependsOn) {
			if (parent.has(dep)) {
				union(node.id, dep);
			}
		}
	}

	// Group nodes by component root
	const componentMap = new Map<string, FluidAgentNode[]>();
	for (const node of plan.agents) {
		const root = find(node.id);
		let members = componentMap.get(root);
		if (!members) {
			members = [];
			componentMap.set(root, members);
		}
		members.push(node);
	}

	// Single component: return unchanged (no allocation overhead)
	if (componentMap.size === 1) return [plan];

	// Build per-component FluidPlans
	const components: FluidPlan[] = [];
	for (const agents of componentMap.values()) {
		components.push({ agents });
	}
	return components;
}

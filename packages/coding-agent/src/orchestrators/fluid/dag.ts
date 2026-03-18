import type { FluidPlan } from "./types";

interface TopologicalResult {
	order: string[];
	hasCycle: boolean;
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

export function validateDag(plan: FluidPlan): { valid: boolean; errors: string[] } {
	const errors: string[] = [];
	const ids = new Set<string>();

	if (plan.agents.length === 0) {
		errors.push("Plan must contain at least one agent");
	}

	for (const node of plan.agents) {
		if (ids.has(node.id)) {
			errors.push(`Duplicate agent id: ${node.id}`);
			continue;
		}
		ids.add(node.id);
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

	return { valid: errors.length === 0, errors };
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

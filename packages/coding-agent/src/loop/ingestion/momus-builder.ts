import type { ManifestSnapshot } from "../types";
import type { DependencyGraph } from "../../org/org-depend";

export interface MomusInput {
	manifestSummary: {
		version: number;
		ticketCount: number;
		layerDistribution: Record<string, number>;
	};
	tickets: Array<{
		id: string;
		title: string;
		state: string;
		dependencyCount: number;
		gateCount: number;
		hasAcceptanceCriteria: boolean;
	}>;
	dependencyAnalysis: {
		isAcyclic: boolean;
		maxDepth: number;
		bottlenecks: string[];
	};
	gateAnalysis: {
		ticketsWithGates: number;
		ticketsWithoutGates: number;
		gateTypeDistribution: Record<string, number>;
	};
	warnings: string[];
}

/**
 * Compute the longest dependency chain length using BFS from roots.
 * Edges go from blocker → dependent (from → to in the graph).
 */
function computeMaxDepth(edges: Array<{ from: string; to: string }>): number {
	if (edges.length === 0) return 0;

	const adjacency = new Map<string, string[]>();
	const inDegree = new Map<string, number>();
	const allNodes = new Set<string>();

	for (const e of edges) {
		allNodes.add(e.from);
		allNodes.add(e.to);
		if (!adjacency.has(e.from)) adjacency.set(e.from, []);
		adjacency.get(e.from)!.push(e.to);
		inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
		if (!inDegree.has(e.from)) inDegree.set(e.from, 0);
	}

	// Longest path via topological BFS (Kahn's with depth tracking)
	const depth = new Map<string, number>();
	const queue: string[] = [];

	for (const id of allNodes) {
		if ((inDegree.get(id) ?? 0) === 0) {
			queue.push(id);
			depth.set(id, 0);
		}
	}

	let maxDepth = 0;
	while (queue.length > 0) {
		const node = queue.shift()!;
		const d = depth.get(node)!;
		for (const neighbor of adjacency.get(node) ?? []) {
			const newDepth = d + 1;
			const current = depth.get(neighbor) ?? 0;
			if (newDepth > current) {
				depth.set(neighbor, newDepth);
			}
			if (newDepth > maxDepth) maxDepth = newDepth;

			const remaining = inDegree.get(neighbor)! - 1;
			inDegree.set(neighbor, remaining);
			if (remaining === 0) {
				queue.push(neighbor);
			}
		}
	}

	return maxDepth;
}

/** Find tickets with the most dependents (outgoing edges = most things depend on them). */
function findBottlenecks(edges: Array<{ from: string; to: string }>, threshold: number): string[] {
	if (edges.length === 0) return [];

	const outCount = new Map<string, number>();
	for (const e of edges) {
		outCount.set(e.from, (outCount.get(e.from) ?? 0) + 1);
	}

	// Sort by count descending, take those above threshold
	return [...outCount.entries()]
		.filter(([, count]) => count >= threshold)
		.sort((a, b) => b[1] - a[1])
		.map(([id]) => id);
}

/** Build Momus validation input from manifest and dependency graph. */
export function buildMomusInput(manifest: ManifestSnapshot, graph: DependencyGraph): MomusInput {
	const { tickets } = manifest;

	// -- manifestSummary --
	const layerDistribution: Record<string, number> = {};

	for (const t of tickets) {
		if (t.layer) {
			layerDistribution[t.layer] = (layerDistribution[t.layer] ?? 0) + 1;
		}
	}

	const manifestSummary = {
		version: manifest.version,
		ticketCount: tickets.length,
		layerDistribution,
	};

	// -- tickets --
	const ticketSummaries = tickets.map(t => ({
		id: t.id,
		title: t.title,
		state: t.state,
		dependencyCount: t.dependencies.length,
		gateCount: t.gates.length,
		hasAcceptanceCriteria: t.acceptanceCriteria.length > 0,
	}));

	// -- dependencyAnalysis --
	const edges = manifest.dependencyEdges;
	const maxDepth = computeMaxDepth(edges);
	const bottlenecks = findBottlenecks(edges, 2);

	const dependencyAnalysis = {
		isAcyclic: graph.cycles.length === 0,
		maxDepth,
		bottlenecks,
	};

	// -- gateAnalysis --
	let ticketsWithGates = 0;
	let ticketsWithoutGates = 0;
	const gateTypeDistribution: Record<string, number> = {};

	for (const t of tickets) {
		if (t.gates.length > 0) {
			ticketsWithGates++;
			for (const g of t.gates) {
				gateTypeDistribution[g.type] = (gateTypeDistribution[g.type] ?? 0) + 1;
			}
		} else {
			ticketsWithoutGates++;
		}
	}

	const gateAnalysis = {
		ticketsWithGates,
		ticketsWithoutGates,
		gateTypeDistribution,
	};

	// -- warnings --
	const warnings: string[] = [];

	for (const t of tickets) {
		if (t.acceptanceCriteria.length === 0) {
			warnings.push(`Ticket ${t.id} has no acceptance criteria`);
		}
		if (t.gates.length === 0) {
			warnings.push(`Ticket ${t.id} has no gates defined`);
		}
	}

	// Bottleneck warnings
	for (const id of bottlenecks) {
		const count = edges.filter(e => e.from === id).length;
		warnings.push(`Ticket ${id} is a bottleneck — ${count} tickets depend on it`);
	}

	return {
		manifestSummary,
		tickets: ticketSummaries,
		dependencyAnalysis,
		gateAnalysis,
		warnings,
	};
}

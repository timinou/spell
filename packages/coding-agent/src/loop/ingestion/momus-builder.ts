import type { ManifestSnapshot, ManifestTicket } from "../types";
import type { DependencyGraph } from "./org-depend";

export interface MomusInput {
	manifestSummary: {
		version: number;
		ticketCount: number;
		totalEffort: string;
		priorityDistribution: Record<string, number>;
		layerDistribution: Record<string, number>;
	};
	tickets: Array<{
		id: string;
		title: string;
		state: string;
		effort?: string;
		priority?: string;
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

/** Sum org duration strings like "2h", "30min", "1d". Returns concatenated form for mixed units. */
function sumEffort(tickets: ManifestTicket[]): string {
	let totalMinutes = 0;
	let hasUnparseable = false;

	for (const t of tickets) {
		if (!t.effort) continue;
		const parsed = parseEffortToMinutes(t.effort);
		if (parsed === undefined) {
			hasUnparseable = true;
		} else {
			totalMinutes += parsed;
		}
	}

	if (totalMinutes === 0 && !hasUnparseable) return "0";
	if (hasUnparseable) {
		// Fall back to concatenation when we can't parse everything
		const parts = tickets.filter(t => t.effort).map(t => t.effort!);
		return parts.join(" + ");
	}

	// Format back to human-readable
	const hours = Math.floor(totalMinutes / 60);
	const mins = totalMinutes % 60;
	if (hours === 0) return `${mins}min`;
	if (mins === 0) return `${hours}h`;
	return `${hours}h${mins}min`;
}

function parseEffortToMinutes(effort: string): number | undefined {
	// Match patterns like "2h", "30min", "1d", "1h30min", "2:30"
	let total = 0;
	let matched = false;

	// "Xd" days
	const dayMatch = /(\d+)d/i.exec(effort);
	if (dayMatch) {
		total += Number.parseInt(dayMatch[1], 10) * 480; // 8h workday
		matched = true;
	}

	// "Xh" hours
	const hourMatch = /(\d+)h/i.exec(effort);
	if (hourMatch) {
		total += Number.parseInt(hourMatch[1], 10) * 60;
		matched = true;
	}

	// "Xmin" minutes
	const minMatch = /(\d+)min/i.exec(effort);
	if (minMatch) {
		total += Number.parseInt(minMatch[1], 10);
		matched = true;
	}

	return matched ? total : undefined;
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
	const priorityDistribution: Record<string, number> = {};
	const layerDistribution: Record<string, number> = {};

	for (const t of tickets) {
		if (t.priority) {
			priorityDistribution[t.priority] = (priorityDistribution[t.priority] ?? 0) + 1;
		}
		if (t.layer) {
			layerDistribution[t.layer] = (layerDistribution[t.layer] ?? 0) + 1;
		}
	}

	const manifestSummary = {
		version: manifest.version,
		ticketCount: tickets.length,
		totalEffort: sumEffort(tickets),
		priorityDistribution,
		layerDistribution,
	};

	// -- tickets --
	const ticketSummaries = tickets.map(t => ({
		id: t.id,
		title: t.title,
		state: t.state,
		effort: t.effort,
		priority: t.priority,
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
		if (!t.priority) {
			warnings.push(`Ticket ${t.id} has no priority assigned`);
		}
	}

	// High-effort tickets without decomposition (no child dependencies)
	const highEffortThreshold = 480; // 8h / 1d
	for (const t of tickets) {
		if (!t.effort) continue;
		const mins = parseEffortToMinutes(t.effort);
		if (mins !== undefined && mins >= highEffortThreshold) {
			const hasChildren = edges.some(e => e.from === t.id);
			if (!hasChildren) {
				warnings.push(
					`Ticket ${t.id} has high effort (${t.effort}) but no sub-tasks depend on it — consider decomposition`,
				);
			}
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

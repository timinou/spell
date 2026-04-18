import type { DependencyGraph, OrgDependProperties } from "./org-depend";
import { buildDependencyGraph } from "./org-depend";
import type { ParsedSpecFile } from "./parser";

export interface MetisInput {
	specSummary: string;
	specFiles: Array<{
		path: string;
		itemCount: number;
		customIds: string[];
		unresolvedLinks: string[];
	}>;
	dependencyReport: {
		totalItems: number;
		totalEdges: number;
		hasCycles: boolean;
		cycles: string[][];
		orphanItems: string[];
		criticalPath: string[];
	};
	coverageGaps: {
		itemsWithoutAcceptance: string[];
		itemsWithoutGates: string[];
	};
}

/** Build Metis input from parsed specs and dependency data. */
export function buildMetisInput(specFiles: ParsedSpecFile[], dependencies: OrgDependProperties[]): MetisInput {
	const allCustomIds = new Set<string>();
	for (const dep of dependencies) {
		allCustomIds.add(dep.customId);
	}
	for (const spec of specFiles) {
		for (const id of spec.customIds) {
			allCustomIds.add(id);
		}
	}

	const specFileEntries = specFiles.map(spec => ({
		path: spec.path,
		itemCount: spec.customIds.length,
		customIds: spec.customIds,
		unresolvedLinks: spec.links.filter(link => !allCustomIds.has(link)),
	}));

	const graph = buildDependencyGraph(dependencies);
	const dependencyReport = buildDependencyReport(graph, dependencies);
	const coverageGaps = buildCoverageGaps(dependencies, specFiles);
	const specSummary = buildSpecSummary(specFiles, dependencyReport);

	return {
		specSummary,
		specFiles: specFileEntries,
		dependencyReport,
		coverageGaps,
	};
}

// -- Dependency report --------------------------------------------------------

interface DepReport {
	totalItems: number;
	totalEdges: number;
	hasCycles: boolean;
	cycles: string[][];
	orphanItems: string[];
	criticalPath: string[];
}

function buildDependencyReport(graph: DependencyGraph, dependencies: OrgDependProperties[]): DepReport {
	const hasCycles = graph.cycles.length > 0;

	// Build adjacency and reverse-adjacency for orphan/critical-path analysis
	const hasIncoming = new Set<string>();
	const hasOutgoing = new Set<string>();
	const adjacency = new Map<string, string[]>();

	for (const id of graph.nodes.keys()) {
		adjacency.set(id, []);
	}

	for (const e of graph.edges) {
		hasOutgoing.add(e.from);
		hasIncoming.add(e.to);
		if (!adjacency.has(e.from)) adjacency.set(e.from, []);
		adjacency.get(e.from)!.push(e.to);
	}

	// Orphans: items with no incoming and no outgoing edges
	const orphanItems: string[] = [];
	for (const id of graph.nodes.keys()) {
		if (!hasIncoming.has(id) && !hasOutgoing.has(id)) {
			orphanItems.push(id);
		}
	}
	orphanItems.sort();

	// Critical path: longest chain via DP on topological order (only if acyclic)
	const criticalPath = hasCycles ? [] : computeCriticalPath(graph.nodes, adjacency);

	return {
		totalItems: dependencies.length,
		totalEdges: graph.edges.length,
		hasCycles,
		cycles: graph.cycles,
		orphanItems,
		criticalPath,
	};
}

/**
 * Compute the longest dependency chain using DP on topological order.
 * Returns the sequence of IDs on the longest path.
 */
function computeCriticalPath(nodes: Map<string, OrgDependProperties>, adjacency: Map<string, string[]>): string[] {
	// Kahn's algorithm for topological order
	const inDegree = new Map<string, number>();
	for (const id of nodes.keys()) {
		inDegree.set(id, 0);
	}
	for (const [, neighbors] of adjacency) {
		for (const n of neighbors) {
			if (inDegree.has(n)) {
				inDegree.set(n, (inDegree.get(n) ?? 0) + 1);
			}
		}
	}

	const queue: string[] = [];
	for (const [id, deg] of inDegree) {
		if (deg === 0) queue.push(id);
	}
	queue.sort();

	const order: string[] = [];
	while (queue.length > 0) {
		const node = queue.shift()!;
		order.push(node);
		for (const neighbor of adjacency.get(node) ?? []) {
			if (!inDegree.has(neighbor)) continue;
			const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
			inDegree.set(neighbor, newDeg);
			if (newDeg === 0) {
				const idx = queue.findIndex(q => q > neighbor);
				if (idx === -1) queue.push(neighbor);
				else queue.splice(idx, 0, neighbor);
			}
		}
	}

	// DP: longest path ending at each node
	const dist = new Map<string, number>();
	const predecessor = new Map<string, string | undefined>();
	for (const id of order) {
		dist.set(id, 0);
		predecessor.set(id, undefined);
	}

	for (const u of order) {
		const du = dist.get(u)!;
		for (const v of adjacency.get(u) ?? []) {
			if (!dist.has(v)) continue;
			if (du + 1 > dist.get(v)!) {
				dist.set(v, du + 1);
				predecessor.set(v, u);
			}
		}
	}

	// Find the node with maximum distance
	let maxDist = 0;
	let endNode: string | undefined;
	for (const [id, d] of dist) {
		if (d > maxDist) {
			maxDist = d;
			endNode = id;
		}
	}

	if (endNode === undefined || maxDist === 0) return [];

	// Trace back the path
	const path: string[] = [];
	let current: string | undefined = endNode;
	while (current !== undefined) {
		path.push(current);
		current = predecessor.get(current);
	}
	path.reverse();
	return path;
}

// -- Coverage gaps ------------------------------------------------------------

/** Check for acceptance criteria by looking for `** Acceptance` heading in spec content. */
function hasAcceptanceCriteria(customId: string, specFiles: ParsedSpecFile[]): boolean {
	for (const spec of specFiles) {
		if (!spec.customIds.includes(customId)) continue;
		// Check if the spec file contains an Acceptance Criteria heading
		// following the item's custom ID
		if (/^\*+\s+Acceptance/m.test(spec.content)) return true;
	}
	return false;
}

function buildCoverageGaps(
	dependencies: OrgDependProperties[],
	specFiles: ParsedSpecFile[],
): MetisInput["coverageGaps"] {
	const itemsWithoutAcceptance: string[] = [];
	const itemsWithoutGates: string[] = [];

	for (const dep of dependencies) {
		if (!hasAcceptanceCriteria(dep.customId, specFiles)) {
			itemsWithoutAcceptance.push(dep.customId);
		}
		if (!dep.gateCmd && !dep.gateArtifact && !dep.gateLlm) {
			itemsWithoutGates.push(dep.customId);
		}
	}

	return {
		itemsWithoutAcceptance,
		itemsWithoutGates,
	};
}

// -- Spec summary -------------------------------------------------------------

function buildSpecSummary(specFiles: ParsedSpecFile[], report: DepReport): string {
	const lines: string[] = [];
	lines.push(`# Spec Summary`);
	lines.push(``);
	lines.push(`- **Files:** ${specFiles.length}`);

	const totalItems = specFiles.reduce((sum, s) => sum + s.customIds.length, 0);
	lines.push(`- **Total items across specs:** ${totalItems}`);
	lines.push(`- **Dependency edges:** ${report.totalEdges}`);
	lines.push(`- **Has cycles:** ${report.hasCycles ? "Yes" : "No"}`);
	lines.push(`- **Orphan items:** ${report.orphanItems.length}`);
	lines.push(`- **Critical path length:** ${report.criticalPath.length}`);
	lines.push(``);

	if (specFiles.length > 0) {
		lines.push(`## Files`);
		lines.push(``);
		for (const spec of specFiles) {
			lines.push(`- \`${spec.path}\`: ${spec.customIds.length} items`);
		}
	}

	return lines.join("\n");
}

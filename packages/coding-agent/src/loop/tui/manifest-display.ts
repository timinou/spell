import type { DependencyGraph } from "../ingestion/org-depend";
import type { ManifestSnapshot, ManifestTicket } from "../types";

const MAX_ID_LENGTH = 40;

function truncateId(id: string): string {
	return id.length > MAX_ID_LENGTH ? `${id.slice(0, MAX_ID_LENGTH - 1)}…` : id;
}

function countByState(tickets: ManifestTicket[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const t of tickets) {
		counts.set(t.state, (counts.get(t.state) ?? 0) + 1);
	}
	return counts;
}

function countByPriority(tickets: ManifestTicket[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const t of tickets) {
		const p = t.priority ?? "none";
		counts.set(p, (counts.get(p) ?? 0) + 1);
	}
	return counts;
}

function sumEffortHours(tickets: ManifestTicket[]): number {
	let total = 0;
	for (const t of tickets) {
		if (!t.effort) continue;
		const match = /^(\d+(?:\.\d+)?)\s*h$/i.exec(t.effort.trim());
		if (match) total += Number.parseFloat(match[1]);
	}
	return total;
}

function computeMaxDepth(edges: Array<{ from: string; to: string }>): number {
	if (edges.length === 0) return 0;

	const children = new Map<string, string[]>();
	const allNodes = new Set<string>();
	const hasParent = new Set<string>();

	for (const e of edges) {
		allNodes.add(e.from);
		allNodes.add(e.to);
		hasParent.add(e.to);
		const list = children.get(e.from);
		if (list) list.push(e.to);
		else children.set(e.from, [e.to]);
	}

	const roots = [...allNodes].filter(n => !hasParent.has(n));

	let maxDepth = 0;
	const stack: Array<{ id: string; depth: number }> = roots.map(id => ({
		id,
		depth: 1,
	}));

	while (stack.length > 0) {
		const { id, depth } = stack.pop()!;
		if (depth > maxDepth) maxDepth = depth;
		const kids = children.get(id);
		if (kids) {
			for (const kid of kids) {
				stack.push({ id: kid, depth: depth + 1 });
			}
		}
	}

	return maxDepth;
}

/** Render a compact manifest summary for TUI display. */
export function renderManifestSummary(manifest: ManifestSnapshot): string {
	const { tickets } = manifest;
	if (tickets.length === 0) return "No tickets in manifest";

	const states = countByState(tickets);
	const done = states.get("DONE") ?? 0;
	const active = states.get("DOING") ?? 0;
	const blocked = states.get("BLOCKED") ?? 0;
	const hold = states.get("HOLD") ?? 0;
	const remaining = tickets.length - done - active - blocked - hold;

	const priorities = countByPriority(tickets);
	const prioEntries: string[] = [];
	for (const p of ["#A", "#B", "#C"]) {
		const c = priorities.get(p);
		if (c) prioEntries.push(`${p}(${c})`);
	}
	const noPrio = priorities.get("none");
	if (noPrio) prioEntries.push(`unset(${noPrio})`);

	const effort = sumEffortHours(tickets);
	const effortStr = effort > 0 ? `~${effort}h` : "unestimated";

	const edgeCount = manifest.dependencyEdges.length;
	const maxDepth = computeMaxDepth(manifest.dependencyEdges);

	const lines = [
		`Manifest v${manifest.version} | ${tickets.length} tickets | ${done} done | ${active} active | ${blocked} blocked | ${remaining} remaining`,
		`Priority: ${prioEntries.length > 0 ? prioEntries.join(" ") : "none set"} | Effort: ${effortStr}`,
		`Dependencies: ${edgeCount} edges, max depth ${maxDepth}`,
	];
	return lines.join("\n");
}

/** Render the dependency chain as an ASCII tree. */
export function renderDependencyTree(manifest: ManifestSnapshot, graph: DependencyGraph): string {
	if (manifest.dependencyEdges.length === 0) return "No dependencies";

	const ticketMap = new Map<string, ManifestTicket>();
	for (const t of manifest.tickets) ticketMap.set(t.id, t);

	// Build parent->children from edges (from depends on to, so to is parent)
	const children = new Map<string, string[]>();
	const hasParent = new Set<string>();
	const allIds = new Set<string>();

	for (const e of graph.edges) {
		allIds.add(e.from);
		allIds.add(e.to);
		// from depends on to: to is parent, from is child
		hasParent.add(e.from);
		const list = children.get(e.to);
		if (list) list.push(e.from);
		else children.set(e.to, [e.from]);
	}

	const roots = [...allIds].filter(id => !hasParent.has(id));
	roots.sort();

	const lines: string[] = [];

	function renderNode(id: string, indent: string): void {
		const ticket = ticketMap.get(id);
		const state = ticket?.state ?? "?";
		const displayId = truncateId(id);
		lines.push(`${indent}${displayId} [${state}]`);

		const kids = children.get(id);
		if (!kids || kids.length === 0) return;
		kids.sort();
		for (const kid of kids) {
			renderNode(kid, `${indent}  |- `);
		}
	}

	for (const root of roots) {
		renderNode(root, "");
	}

	return lines.join("\n");
}

/** Render a gate overview showing which tickets have which gates. */
export function renderGateOverview(manifest: ManifestSnapshot): string {
	const { tickets } = manifest;
	if (tickets.length === 0) return "No tickets in manifest";

	const withGates = tickets.filter(t => t.gates.length > 0);
	if (withGates.length === 0) return "No gates configured";

	const gateTypeCounts = new Map<string, number>();
	for (const t of withGates) {
		for (const g of t.gates) {
			gateTypeCounts.set(g.type, (gateTypeCounts.get(g.type) ?? 0) + 1);
		}
	}

	const pct = Math.round((withGates.length / tickets.length) * 100);
	const typeParts = [...gateTypeCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([type, count]) => `${type}: ${count}`);

	const uncovered = tickets.filter(t => t.gates.length === 0);
	const uncoveredStr =
		uncovered.length > 0
			? `Uncovered: ${uncovered.map(t => truncateId(t.id)).join(", ")} (no gates)`
			: "All tickets have gates";

	return [`Gates: ${withGates.length} tickets with gates (${pct}%)`, `  ${typeParts.join(" | ")}`, uncoveredStr].join(
		"\n",
	);
}

/** Render a diff between two manifest versions (for replan display). */
export function renderManifestDiff(previous: ManifestSnapshot, current: ManifestSnapshot): string {
	const prevMap = new Map<string, ManifestTicket>();
	for (const t of previous.tickets) prevMap.set(t.id, t);

	const currMap = new Map<string, ManifestTicket>();
	for (const t of current.tickets) currMap.set(t.id, t);

	const lines: string[] = [`Replan v${previous.version} -> v${current.version}`];

	let hasChanges = false;

	// Added tickets
	for (const t of current.tickets) {
		if (!prevMap.has(t.id)) {
			lines.push(`  + ${truncateId(t.id)} [${t.state}]`);
			hasChanges = true;
		}
	}

	// Removed tickets
	for (const t of previous.tickets) {
		if (!currMap.has(t.id)) {
			lines.push(`  - ${truncateId(t.id)} (was ${t.state})`);
			hasChanges = true;
		}
	}

	// Changed tickets
	for (const t of current.tickets) {
		const prev = prevMap.get(t.id);
		if (!prev) continue;

		const changes: string[] = [];
		if (prev.state !== t.state) changes.push(`state ${prev.state} -> ${t.state}`);
		if (prev.priority !== t.priority) changes.push(`priority ${prev.priority ?? "none"} -> ${t.priority ?? "none"}`);

		if (changes.length > 0) {
			lines.push(`  ~ ${truncateId(t.id)}: ${changes.join(", ")}`);
			hasChanges = true;
		}
	}

	// Preserved tickets
	for (const t of current.tickets) {
		const prev = prevMap.get(t.id);
		if (!prev) continue;
		if (prev.state === t.state && prev.priority === t.priority) {
			lines.push(`  = ${truncateId(t.id)} [${t.state}] (preserved)`);
		}
	}

	if (!hasChanges) return "No changes";

	return lines.join("\n");
}

/** Render full approval display combining summary, deps, and gates. */
export function renderApprovalDisplay(manifest: ManifestSnapshot): string {
	const sections: string[] = [];

	sections.push("── Summary ──");
	sections.push(renderManifestSummary(manifest));
	sections.push("");

	sections.push("── Gates ──");
	sections.push(renderGateOverview(manifest));

	return sections.join("\n");
}

/**
 * Parser for org-depend properties — extracts dependency graphs from org file PROPERTIES drawers.
 *
 * Supports:
 * - :DEPENDS: space-separated IDs (legacy: :BLOCKER:)
 * - :TRIGGER: space-separated ID(KEYWORD) expressions
 * - :GATE_CMD:, :GATE_ARTIFACT:, :GATE_LLM: single-value properties
 * - Standard: :CUSTOM_ID:, :EFFORT:, :PRIORITY:, :LAYER:
 */

// -- Types ------------------------------------------------------------------

export interface TriggerRule {
	targetId: string;
	keyword: string;
}

export interface OrgDependProperties {
	customId: string;
	title: string;
	state: string;
	blockers: string[];
	triggers: TriggerRule[];
	gateCmd?: string;
	gateArtifact?: string;
	gateLlm?: string;
	effort?: string;
	priority?: string;
	layer?: string;
}

export interface DependencyGraph {
	nodes: Map<string, OrgDependProperties>;
	edges: Array<{ from: string; to: string }>;
	cycles: string[][];
}

// -- Trigger expression parsing ---------------------------------------------

const TRIGGER_RE = /^([^\s(]+)\(([^)]+)\)$/;

/** Parse `ID(KEYWORD)` format. Returns undefined for malformed input. */
export function parseTriggerExpression(expr: string): TriggerRule | undefined {
	const m = TRIGGER_RE.exec(expr.trim());
	if (!m) return undefined;
	return { targetId: m[1], keyword: m[2] };
}

// -- Single-file parsing ----------------------------------------------------

/**
 * Regex for a heading line: captures state keyword and title.
 * Matches `* STATE Title` or `** STATE Title` etc.
 * State is any all-caps word (e.g. ITEM, DOING, DONE, BLOCKED).
 */
const HEADING_RE = /^(\*+)\s+([A-Z][A-Z_]+)\s+(.*?)\s*$/;

/** Matches a heading without a TODO keyword — just `* Title`. */
const HEADING_NO_STATE_RE = /^(\*+)\s+(?![A-Z][A-Z_]+\s)(.*?)\s*$/;

interface RawHeading {
	level: number;
	state: string;
	title: string;
	propertiesBlock: string | undefined;
}

/**
 * Parse all headings and their immediately-following PROPERTIES drawers from org content.
 * Handles multiple headings per file.
 */
function extractHeadings(content: string): RawHeading[] {
	const lines = content.split("\n");
	const headings: RawHeading[] = [];

	for (let i = 0; i < lines.length; i++) {
		let level: number;
		let state: string;
		let title: string;

		const m = HEADING_RE.exec(lines[i]);
		if (m) {
			level = m[1].length;
			state = m[2];
			title = m[3];
		} else {
			const m2 = HEADING_NO_STATE_RE.exec(lines[i]);
			if (m2) {
				level = m2[1].length;
				state = "";
				title = m2[2];
			} else {
				continue;
			}
		}

		// Look for PROPERTIES drawer after heading (skip blank lines)
		let propsBlock: string | undefined;
		let j = i + 1;
		// Skip non-heading, non-property lines until we hit :PROPERTIES: or another heading
		while (j < lines.length) {
			const trimmed = lines[j].trim();
			if (trimmed === ":PROPERTIES:") {
				// Collect until :END:
				const start = j;
				j++;
				while (j < lines.length && lines[j].trim() !== ":END:") j++;
				if (j < lines.length) {
					propsBlock = lines.slice(start, j + 1).join("\n");
				}
				break;
			}
			if (trimmed.startsWith("*")) break; // next heading, no properties
			if (trimmed !== "" && !trimmed.startsWith(":") && !trimmed.startsWith("#")) break;
			j++;
		}

		headings.push({ level, state, title, propertiesBlock: propsBlock });
	}

	return headings;
}

const PROP_RE = /^\s*:([A-Z_]+):\s*(.*?)\s*$/;

function extractProperty(block: string, name: string): string | undefined {
	for (const line of block.split("\n")) {
		const m = PROP_RE.exec(line);
		if (m && m[1] === name) return m[2];
	}
	return undefined;
}

/** Parse a single org file's content into OrgDependProperties for each heading with a CUSTOM_ID. */
export function parseOrgDependProperties(content: string): OrgDependProperties[] {
	const headings = extractHeadings(content);
	const results: OrgDependProperties[] = [];

	for (const h of headings) {
		if (!h.propertiesBlock) continue;
		const customId = extractProperty(h.propertiesBlock, "CUSTOM_ID");
		if (!customId) continue;

		const blockerRaw =
			extractProperty(h.propertiesBlock, "DEPENDS") ?? extractProperty(h.propertiesBlock, "BLOCKER") ?? "";
		const blockers = blockerRaw.split(/\s+/).filter(s => s.length > 0);

		const triggerRaw = extractProperty(h.propertiesBlock, "TRIGGER") ?? "";
		const triggers: TriggerRule[] = [];
		for (const tok of triggerRaw.split(/\s+/)) {
			if (!tok) continue;
			const rule = parseTriggerExpression(tok);
			if (rule) triggers.push(rule);
		}

		const entry: OrgDependProperties = {
			customId,
			title: h.title,
			state: h.state,
			blockers,
			triggers,
			gateCmd: extractProperty(h.propertiesBlock, "GATE_CMD") ?? undefined,
			gateArtifact: extractProperty(h.propertiesBlock, "GATE_ARTIFACT") ?? undefined,
			gateLlm: extractProperty(h.propertiesBlock, "GATE_LLM") ?? undefined,
			effort: extractProperty(h.propertiesBlock, "EFFORT") ?? undefined,
			priority: extractProperty(h.propertiesBlock, "PRIORITY") ?? undefined,
			layer: extractProperty(h.propertiesBlock, "LAYER") ?? undefined,
		};

		results.push(entry);
	}

	return results;
}

// -- Multi-file parsing -----------------------------------------------------

/** Parse multiple files and collect all dependency properties. */
export function parseAllOrgDependencies(files: Array<{ path: string; content: string }>): OrgDependProperties[] {
	const results: OrgDependProperties[] = [];
	for (const f of files) {
		results.push(...parseOrgDependProperties(f.content));
	}
	return results;
}

// -- Graph construction & cycle detection -----------------------------------

/** Three-color DFS cycle detection. */
function detectCycles(adjacency: Map<string, string[]>, nodeIds: Set<string>): string[][] {
	const WHITE = 0;
	const GRAY = 1;
	const BLACK = 2;

	const color = new Map<string, number>();
	for (const id of nodeIds) color.set(id, WHITE);

	const cycles: string[][] = [];

	function dfs(node: string, path: string[]): void {
		color.set(node, GRAY);
		path.push(node);

		for (const neighbor of adjacency.get(node) ?? []) {
			const c = color.get(neighbor);
			if (c === GRAY) {
				// Back edge — extract the cycle from path
				const cycleStart = path.indexOf(neighbor);
				cycles.push(path.slice(cycleStart));
			} else if (c === WHITE) {
				dfs(neighbor, path);
			}
		}

		path.pop();
		color.set(node, BLACK);
	}

	for (const id of nodeIds) {
		if (color.get(id) === WHITE) {
			dfs(id, []);
		}
	}

	return cycles;
}

/**
 * Build a directed dependency graph from parsed properties.
 * Edges: from=dependency, to=the item that declared the dependency (dependent).
 */
export function buildDependencyGraph(properties: OrgDependProperties[]): DependencyGraph {
	const nodes = new Map<string, OrgDependProperties>();
	const edges: Array<{ from: string; to: string }> = [];

	for (const p of properties) {
		nodes.set(p.customId, p);
	}

	// adjacency for cycle detection: from → [to] (dependency → dependent)
	const adjacency = new Map<string, string[]>();
	for (const id of nodes.keys()) adjacency.set(id, []);

	for (const p of properties) {
		for (const blocker of p.blockers) {
			edges.push({ from: blocker, to: p.customId });
			if (!adjacency.has(blocker)) adjacency.set(blocker, []);
			adjacency.get(blocker)!.push(p.customId);
		}
	}

	const allIds = new Set([...nodes.keys(), ...edges.map(e => e.from)]);
	const cycles = detectCycles(adjacency, allIds);

	return { nodes, edges, cycles };
}

// -- Topological sort -------------------------------------------------------

/** Kahn's algorithm. Throws if the graph contains cycles. */
export function topologicalSort(graph: DependencyGraph): string[] {
	if (graph.cycles.length > 0) {
		throw new Error(
			`Cannot topologically sort graph with cycles: ${graph.cycles.map(c => c.join(" -> ")).join("; ")}`,
		);
	}

	// Build in-degree map over all node IDs present in edges or nodes
	const allIds = new Set<string>();
	for (const id of graph.nodes.keys()) allIds.add(id);
	for (const e of graph.edges) {
		allIds.add(e.from);
		allIds.add(e.to);
	}

	const inDegree = new Map<string, number>();
	const adjacency = new Map<string, string[]>();
	for (const id of allIds) {
		inDegree.set(id, 0);
		adjacency.set(id, []);
	}

	for (const e of graph.edges) {
		adjacency.get(e.from)!.push(e.to);
		inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
	}

	const queue: string[] = [];
	for (const [id, deg] of inDegree) {
		if (deg === 0) queue.push(id);
	}
	// Stable sort for deterministic output
	queue.sort();

	const result: string[] = [];
	while (queue.length > 0) {
		const node = queue.shift()!;
		result.push(node);
		for (const neighbor of adjacency.get(node) ?? []) {
			const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
			inDegree.set(neighbor, newDeg);
			if (newDeg === 0) {
				// Insert sorted for determinism
				const idx = queue.findIndex(q => q > neighbor);
				if (idx === -1) queue.push(neighbor);
				else queue.splice(idx, 0, neighbor);
			}
		}
	}

	return result;
}

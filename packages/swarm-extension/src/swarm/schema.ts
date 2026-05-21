// ============================================================================
// Raw YAML shape (snake_case, optional fields)
// ============================================================================

interface RawSwarmAgentConfig {
	role: string;
	task: string;
	extra_context?: string;
	reports_to?: string[];
	waits_for?: string[];
	model?: string;
}

interface RawSwarmConfig {
	name: string;
	workspace: string;
	mode?: string;
	target_count?: number;
	model?: string;
	agents: Record<string, RawSwarmAgentConfig>;
}

// ============================================================================
// Normalized types (camelCase, defaults applied)
// ============================================================================

export type SwarmMode = "pipeline" | "parallel" | "sequential";

export interface SwarmAgent {
	name: string;
	role: string;
	task: string;
	extraContext?: string;
	reportsTo: string[];
	waitsFor: string[];
	model?: string;
}

export interface SwarmDefinition {
	name: string;
	workspace: string;
	mode: SwarmMode;
	targetCount: number;
	model?: string;
	agents: Map<string, SwarmAgent>;
	/** Preserves YAML declaration order for implicit pipeline sequencing. */
	agentOrder: string[];
}

// ============================================================================
// Parsing
// ============================================================================

const VALID_MODES = new Set<string>(["pipeline", "parallel", "sequential"]);
const VALID_SWARM_NAME = /^[a-zA-Z0-9._-]+$/;

/**
 * Detect the format of a swarm definition by content sniff. KDL files start
 * with `swarm "name" ...`; YAML files start with `swarm:` or other YAML
 * top-level syntax. The shape is unambiguous because both formats are
 * top-level node declarations of the same name.
 */
function detectFormat(content: string): "kdl" | "yaml" {
	// Strip leading whitespace + comments before sniffing. KDL files can open
	// with `// line` or `/* block */` comments, and YAML can open with `# line`
	// comments. Without this peek, e.g. `// swarm for demo\nswarm "demo" {...}`
	// falsely classifies as YAML and surfaces a confusing parse error.
	let i = 0;
	while (i < content.length) {
		// skip whitespace
		while (i < content.length && /\s/.test(content[i])) i++;
		if (i >= content.length) break;
		// KDL line comment
		if (content[i] === "/" && content[i + 1] === "/") {
			while (i < content.length && content[i] !== "\n") i++;
			continue;
		}
		// KDL block comment
		if (content[i] === "/" && content[i + 1] === "*") {
			i += 2;
			while (i < content.length - 1 && !(content[i] === "*" && content[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		// YAML/shell line comment
		if (content[i] === "#") {
			while (i < content.length && content[i] !== "\n") i++;
			continue;
		}
		break;
	}
	const rest = content.slice(i);
	if (/^swarm\s+["a-zA-Z0-9._-]/.test(rest)) return "kdl";
	return "yaml";
}

/**
 * Parse a swarm definition, auto-detecting KDL or YAML. KDL is the canonical
 * format (PLAN-311 WAVE 2b); YAML is kept as a deprecated input.
 *
 * @throws on parse or semantic error.
 */
export function parseSwarm(content: string): SwarmDefinition {
	if (detectFormat(content) === "kdl") return parseSwarmKdl(content);
	return parseSwarmYaml(content);
}

export function parseSwarmYaml(content: string): SwarmDefinition {
	const raw = Bun.YAML.parse(content) as { swarm?: RawSwarmConfig } | null;
	if (!raw?.swarm) {
		throw new Error("YAML must have a top-level 'swarm' key");
	}
	const swarm = raw.swarm;

	if (!swarm.name || typeof swarm.name !== "string") {
		throw new Error("swarm.name is required and must be a string");
	}
	if (!VALID_SWARM_NAME.test(swarm.name)) {
		throw new Error("swarm.name may only contain letters, numbers, dot, underscore, and dash");
	}
	if (!swarm.workspace || typeof swarm.workspace !== "string") {
		throw new Error("swarm.workspace is required and must be a string");
	}
	if (!swarm.agents || typeof swarm.agents !== "object" || Object.keys(swarm.agents).length === 0) {
		throw new Error("swarm.agents must contain at least one agent");
	}

	const mode = swarm.mode ?? "sequential";
	if (!VALID_MODES.has(mode)) {
		throw new Error(`Invalid mode '${mode}'. Must be one of: ${[...VALID_MODES].join(", ")}`);
	}

	const agentOrder: string[] = [];
	const agents = new Map<string, SwarmAgent>();

	for (const [name, config] of Object.entries(swarm.agents)) {
		if (!config.role || typeof config.role !== "string") {
			throw new Error(`Agent '${name}': 'role' is required`);
		}
		if (!config.task || typeof config.task !== "string") {
			throw new Error(`Agent '${name}': 'task' is required`);
		}

		agentOrder.push(name);
		agents.set(name, {
			name,
			role: config.role,
			task: config.task.trim(),
			extraContext: config.extra_context?.trim(),
			reportsTo: Array.isArray(config.reports_to) ? config.reports_to : [],
			model: typeof config.model === "string" ? config.model.trim() : undefined,
			waitsFor: Array.isArray(config.waits_for) ? config.waits_for : [],
		});
	}

	return {
		name: swarm.name,
		workspace: swarm.workspace,
		mode: mode as SwarmMode,
		targetCount: swarm.target_count ?? 1,
		model: typeof swarm.model === "string" ? swarm.model.trim() : undefined,
		agents,
		agentOrder,
	};
}

// ============================================================================
// Validation (semantic — references, constraints)
// ============================================================================

export function validateSwarmDefinition(def: SwarmDefinition): string[] {
	const errors: string[] = [];
	const agentNames = new Set(def.agents.keys());

	if (def.model !== undefined && def.model.length === 0) {
		errors.push("swarm.model must not be empty when provided");
	}
	for (const [name, agent] of def.agents) {
		for (const dep of agent.waitsFor) {
			if (!agentNames.has(dep)) {
				errors.push(`Agent '${name}' waits_for unknown agent '${dep}'`);
			}
			if (dep === name) {
				errors.push(`Agent '${name}' cannot wait for itself`);
			}
		}
		for (const target of agent.reportsTo) {
			if (!agentNames.has(target)) {
				errors.push(`Agent '${name}' reports_to unknown agent '${target}'`);
			}
			if (target === name) {
				errors.push(`Agent '${name}' cannot report to itself`);
			}
		}
		if (agent.model !== undefined && agent.model.length === 0) {
			errors.push(`Agent '${name}' model must not be empty when provided`);
		}
	}

	if (def.targetCount < 1) {
		errors.push("target_count must be at least 1");
	}
	if (def.mode !== "pipeline" && def.targetCount !== 1) {
		errors.push("target_count is only supported in pipeline mode");
	}

	return errors;
}

// ============================================================================
// KDL parsing
// ============================================================================
//
// Canonical KDL shape:
//
//   swarm "my-swarm" workspace="." mode="sequential" target-count=3 \
//                    model="claude-sonnet" {
//     agent "researcher" model="claude-sonnet" {
//       role "Investigate the codebase"
//       task """
//         Find all uses of foo.
//         Report each occurrence with line numbers.
//       """
//       extra-context "Focus on the src directory"
//       reports-to "lead"
//       waits-for "data-prep" "init"
//     }
//   }
//
// Top-level KDL `swarm` node identity argument is the name; properties are
// scalar config; child nodes are agents. Each agent's identity is its name;
// properties are scalar config; child nodes are text fields and lists.

import { parse, type Node as KdlNode } from "@bgotink/kdl";

function kdlGetStringArg(node: KdlNode, idx = 0): string | undefined {
	const args = [...node.getArguments()];
	const arg = args[idx];
	return typeof arg === "string" ? arg : undefined;
}

function kdlGetStringArgs(node: KdlNode): string[] {
	return [...node.getArguments()].filter((a): a is string => typeof a === "string");
}

function kdlGetStringProp(node: KdlNode, key: string): string | undefined {
	const val = node.getProperty(key);
	return typeof val === "string" ? val : undefined;
}

function kdlGetNumberProp(node: KdlNode, key: string): number | undefined {
	const val = node.getProperty(key);
	return typeof val === "number" ? val : undefined;
}

function kdlChildren(node: KdlNode): KdlNode[] {
	return [...node.children.nodes];
}

function findChild(node: KdlNode, name: string): KdlNode | undefined {
	return kdlChildren(node).find(n => n.getName() === name);
}

function readListField(parent: KdlNode, name: string): string[] {
	const node = findChild(parent, name);
	if (!node) return [];
	return kdlGetStringArgs(node);
}

function readTextField(parent: KdlNode, name: string): string | undefined {
	const node = findChild(parent, name);
	if (!node) return undefined;
	return kdlGetStringArg(node);
}

export function parseSwarmKdl(content: string): SwarmDefinition {
	let doc;
	try {
		doc = parse(content);
	} catch (err) {
		throw new Error(`KDL parse error: ${err instanceof Error ? err.message : String(err)}`);
	}

	const swarmNode = [...doc.nodes].find(n => n.getName() === "swarm");
	if (!swarmNode) {
		throw new Error("KDL must have a top-level 'swarm' node");
	}

	const name = kdlGetStringArg(swarmNode) ?? kdlGetStringProp(swarmNode, "name");
	if (!name) {
		throw new Error("swarm name is required (positional argument or `name=...`)");
	}
	if (!VALID_SWARM_NAME.test(name)) {
		throw new Error("swarm name may only contain letters, numbers, dot, underscore, and dash");
	}

	const workspace = kdlGetStringProp(swarmNode, "workspace");
	if (!workspace) {
		throw new Error("swarm.workspace is required");
	}

	const mode = kdlGetStringProp(swarmNode, "mode") ?? "sequential";
	if (!VALID_MODES.has(mode)) {
		throw new Error(`Invalid mode '${mode}'. Must be one of: ${[...VALID_MODES].join(", ")}`);
	}

	const targetCount = kdlGetNumberProp(swarmNode, "target-count") ?? 1;
	const swarmModel = kdlGetStringProp(swarmNode, "model");

	const agentNodes = kdlChildren(swarmNode).filter(n => n.getName() === "agent");
	if (agentNodes.length === 0) {
		throw new Error("swarm must contain at least one agent");
	}

	const agentOrder: string[] = [];
	const agents = new Map<string, SwarmAgent>();
	const seenAgentNames = new Set<string>();

	for (const agentNode of agentNodes) {
		const agentName = kdlGetStringArg(agentNode);
		if (!agentName) {
			throw new Error("agent name is required as a positional argument");
		}
		// Reject duplicates early. Without this, agentOrder keeps the duplicate
		// while the Map last-wins-collapses — buildDependencyGraph then chains a
		// self-edge in sequential/pipeline modes and surfaces a confusing
		// "cycle" error for what is really a typo.
		if (seenAgentNames.has(agentName)) {
			throw new Error(`agent name '${agentName}' is duplicated; each agent must have a unique name`);
		}
		seenAgentNames.add(agentName);

		const role = readTextField(agentNode, "role") ?? kdlGetStringProp(agentNode, "role");
		if (!role) {
			throw new Error(`Agent '${agentName}': 'role' is required`);
		}

		const task = (readTextField(agentNode, "task") ?? kdlGetStringProp(agentNode, "task"))?.trim();
		if (!task) {
			throw new Error(`Agent '${agentName}': 'task' is required`);
		}

		const extraContext = (readTextField(agentNode, "extra-context") ?? kdlGetStringProp(agentNode, "extra-context"))?.trim();
		const reportsTo = readListField(agentNode, "reports-to");
		const waitsFor = readListField(agentNode, "waits-for");
		const model = (kdlGetStringProp(agentNode, "model") ?? readTextField(agentNode, "model"))?.trim();

		agentOrder.push(agentName);
		agents.set(agentName, {
			name: agentName,
			role,
			task,
			extraContext,
			reportsTo,
			waitsFor,
			model,
		});
	}

	return {
		name,
		workspace,
		mode: mode as SwarmMode,
		targetCount,
		model: swarmModel,
		agents,
		agentOrder,
	};
}


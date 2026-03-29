import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { TicketState } from "../contracts";
import { GATE_TRIGGERS, TICKET_STATES } from "../contracts";
import type { LoopGateConfig, ManifestSnapshot, ManifestTicket } from "../types";

function parseTicketState(raw: string): TicketState {
	const upper = raw.toUpperCase();
	const valid = Object.values(TICKET_STATES) as string[];
	return valid.includes(upper) ? (upper as TicketState) : TICKET_STATES.item;
}

function parseProperties(content: string): Record<string, string> {
	const props: Record<string, string> = {};
	const drawerMatch = content.match(/:PROPERTIES:[\s\S]*?:END:/g);
	if (!drawerMatch) return props;
	for (const drawer of drawerMatch) {
		for (const line of drawer.split("\n")) {
			const m = line.match(/^\s*:([A-Z_]+):\s*(.+)/);
			if (m?.[1] && m[2]) {
				props[m[1]] = m[2].trim();
			}
		}
	}
	return props;
}

function parseAcceptanceCriteria(content: string): string[] {
	const section = content.match(/\*\* Acceptance Criteria[\s\S]*?(?=\n\*|$)/)?.[0];
	if (!section) return [];
	return Array.from(section.matchAll(/- \[[ x]\] (.+)/g))
		.map(m => m[1] ?? "")
		.filter(Boolean);
}

function parseGatesFromProperties(props: Record<string, string>, customId: string): LoopGateConfig[] {
	const gates: LoopGateConfig[] = [];
	if (props.GATE_CMD) {
		gates.push({
			id: `gate-cmd-${customId}`,
			type: "command",
			command: props.GATE_CMD,
			trigger: { kind: GATE_TRIGGERS.onCompletion },
		});
	}
	if (props.GATE_ARTIFACT) {
		gates.push({
			id: `gate-artifact-${customId}`,
			type: "artifact",
			path: props.GATE_ARTIFACT,
			trigger: { kind: GATE_TRIGGERS.onCompletion },
		});
	}
	if (props.GATE_LLM) {
		gates.push({
			id: `gate-llm-${customId}`,
			type: "llm-review",
			criteria: props.GATE_LLM,
			trigger: { kind: GATE_TRIGGERS.onCompletion },
		});
	}
	return gates;
}

export function parseTicketOrg(content: string): ManifestTicket | undefined {
	const headingMatch = content.match(/^\* (\w+) (.+)/m);
	if (!headingMatch) return undefined;
	const props = parseProperties(content);
	const customId = props.CUSTOM_ID;
	if (!customId) return undefined;
	const tagMatch = content.match(/^#\+TAGS:\s+(.+)/m);
	return {
		id: customId,
		title: headingMatch[2] ?? "",
		state: parseTicketState(headingMatch[1] ?? "ITEM"),
		specPath: props.SPEC_PATH,
		acceptanceCriteria: parseAcceptanceCriteria(content),
		dependencies: props.BLOCKER?.split(/\s+/).filter(Boolean) ?? [],
		triggers: props.TRIGGER?.split(/\s+/).filter(Boolean) ?? [],
		gates: parseGatesFromProperties(props, customId),
		effort: props.EFFORT,
		priority: props.PRIORITY,
		layer: props.LAYER,
		tags: tagMatch?.[1]?.split(/\s+/).filter(Boolean) ?? [],
		changedFiles: props.CHANGED_FILES ? props.CHANGED_FILES.split("|").filter(Boolean) : [],
		findings: props.FINDINGS ? props.FINDINGS.split("|").filter(Boolean) : [],
		orgItemId: props.ORG_ITEM_ID || undefined,
		childLoopId: props.CHILD_LOOP_ID || undefined,
		iterationHistory: props.ITERATION_HISTORY
			? props.ITERATION_HISTORY.split(",")
					.map(Number)
					.filter(n => !Number.isNaN(n))
			: [],
	};
}

export async function readManifest(cwd: string, loopId: string): Promise<ManifestSnapshot | undefined> {
	const manifestDir = path.join(cwd, ".local/!tracks/loops", loopId, "manifest");
	const manifestPath = path.join(cwd, ".local/!tracks/loops", loopId, "manifest.org");
	let indexContent: string;
	try {
		indexContent = await Bun.file(manifestPath).text();
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
	const versionMatch = indexContent.match(/#\+MANIFEST_VERSION:\s*(\d+)/);
	const createdMatch = indexContent.match(/#\+CREATED_AT:\s*(.+)/);
	const updatedMatch = indexContent.match(/#\+UPDATED_AT:\s*(.+)/);

	const tickets: ManifestTicket[] = [];
	try {
		const entries = await fs.readdir(manifestDir);
		for (const entry of entries) {
			if (!entry.endsWith(".org")) continue;
			const ticketContent = await Bun.file(path.join(manifestDir, entry)).text();
			const ticket = parseTicketOrg(ticketContent);
			if (ticket) tickets.push(ticket);
		}
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}

	const dependencyEdges: ManifestSnapshot["dependencyEdges"] = [];
	for (const ticket of tickets) {
		for (const dep of ticket.dependencies) {
			dependencyEdges.push({ from: dep, to: ticket.id });
		}
	}

	const triggerRules: ManifestSnapshot["triggerRules"] = [];
	for (const ticket of tickets) {
		for (const trigger of ticket.triggers) {
			const m = trigger.match(/^([^(]+)\(([^)]+)\)$/);
			if (m?.[1] && m[2]) {
				triggerRules.push({ source: ticket.id, target: m[1], keyword: m[2] });
			}
		}
	}

	return {
		version: Number(versionMatch?.[1] ?? 1),
		tickets,
		dependencyEdges,
		triggerRules,
		manifestOrgPath: manifestPath,
		createdAt: createdMatch?.[1] ? new Date(createdMatch[1]).getTime() : Date.now(),
		updatedAt: updatedMatch?.[1] ? new Date(updatedMatch[1]).getTime() : Date.now(),
	};
}

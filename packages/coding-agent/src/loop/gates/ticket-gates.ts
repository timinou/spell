import { GATE_TRIGGERS } from "../contracts";
import type {
	ArtifactGateConfig,
	CommandGateConfig,
	LlmReviewGateConfig,
	LoopGateConfig,
	ManifestTicket,
} from "../types";

/** Derive per-ticket gate configs from ticket properties. */
export function deriveTicketGates(ticket: ManifestTicket): LoopGateConfig[] {
	const gates: LoopGateConfig[] = [];
	const prefix = `ticket-${ticket.id}`;

	for (const gate of ticket.gates) {
		if (gate.type === "command") {
			gates.push({
				id: `${prefix}-cmd-${gates.length}`,
				type: "command",
				command: (gate as CommandGateConfig).command,
				trigger: { kind: GATE_TRIGGERS.onTicketComplete },
			});
		}
		if (gate.type === "artifact") {
			gates.push({
				id: `${prefix}-artifact-${gates.length}`,
				type: "artifact",
				path: (gate as ArtifactGateConfig).path,
				trigger: { kind: GATE_TRIGGERS.onTicketComplete },
			});
		}
		if (gate.type === "llm-review") {
			gates.push({
				id: `${prefix}-llm-${gates.length}`,
				type: "llm-review",
				criteria: (gate as LlmReviewGateConfig).criteria,
				trigger: { kind: GATE_TRIGGERS.onTicketComplete },
			});
		}
	}

	// Generate LLM review gate from acceptance criteria if no LLM gate exists
	if (ticket.acceptanceCriteria.length > 0 && !gates.some(g => g.type === "llm-review")) {
		gates.push({
			id: `${prefix}-acceptance`,
			type: "llm-review",
			criteria: `Verify these acceptance criteria are met:\n${ticket.acceptanceCriteria.map(c => `- ${c}`).join("\n")}`,
			trigger: { kind: GATE_TRIGGERS.onTicketComplete },
		});
	}

	return gates;
}

/** Derive all per-ticket gates for a manifest. */
export function deriveManifestGates(tickets: ManifestTicket[]): Map<string, LoopGateConfig[]> {
	const result = new Map<string, LoopGateConfig[]>();
	for (const ticket of tickets) {
		const gates = deriveTicketGates(ticket);
		if (gates.length > 0) {
			result.set(ticket.id, gates);
		}
	}
	return result;
}

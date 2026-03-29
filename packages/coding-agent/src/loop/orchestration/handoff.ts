import type { GateDecision, HandoffArtifact, LoopRole } from "../contracts";

export interface HandoffInput {
	fromRole: LoopRole;
	toRole: LoopRole;
	iteration: number;
	changedFiles?: string[];
	gateResults?: GateDecision[];
	openFindings?: string[];
	summary: string;
}

export function createHandoffArtifact(input: HandoffInput): HandoffArtifact {
	return {
		fromRole: input.fromRole,
		toRole: input.toRole,
		iteration: input.iteration,
		changedFiles: [...(input.changedFiles ?? [])],
		gateResults: [...(input.gateResults ?? [])],
		openFindings: [...(input.openFindings ?? [])],
		summary: input.summary,
	};
}

import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import type { OutputMeta } from "./output-meta";
import { toolResult } from "./tool-result";

export const escalateSchema = Type.Object({
	reason: Type.String({
		description: "Why this task exceeds orchestrator scope and needs a full agent",
	}),
	assignment: Type.Optional(
		Type.String({
			description: "Specific assignment for the full agent. If omitted, the original scope is forwarded.",
		}),
	),
});

type EscalateInput = Static<typeof escalateSchema>;

export interface EscalateToolDetails {
	reason: string;
	assignment?: string;
	meta?: OutputMeta;
}

/**
 * Tool available to canvas orchestrators that signals the need to escalate
 * to a full agent. When called, the orchestrator lifecycle manager spawns
 * a full agent via the task executor with the provided assignment.
 *
 * The orchestrator should wait for the escalation result before completing.
 */
export class EscalateTool implements AgentTool<typeof escalateSchema, EscalateToolDetails> {
	readonly name = "escalate";
	readonly label = "Escalate";
	readonly description =
		"Escalate the current task to a full agent when it exceeds orchestrator scope. " +
		"Provide a reason and optionally a specific assignment for the agent.";
	readonly parameters = escalateSchema;
	readonly strict = false;

	/**
	 * Callback set by the orchestrator lifecycle manager to handle escalation.
	 * The manager provides this when creating the orchestrator session.
	 */
	#onEscalate?: (reason: string, assignment?: string) => Promise<string>;

	setEscalateHandler(handler: (reason: string, assignment?: string) => Promise<string>): void {
		this.#onEscalate = handler;
	}

	async execute(_toolCallId: string, params: EscalateInput): Promise<AgentToolResult<EscalateToolDetails>> {
		const { reason, assignment } = params;

		if (!this.#onEscalate) {
			return toolResult<EscalateToolDetails>({ reason })
				.text("Escalation not available \u2014 no handler registered. Complete the task within scope.")
				.done();
		}
		const result = await this.#onEscalate(reason, assignment);
		return toolResult<EscalateToolDetails>({ reason, assignment })
			.text(`Escalation completed. Full agent result:\n\n${result}`)
			.done();
	}
}

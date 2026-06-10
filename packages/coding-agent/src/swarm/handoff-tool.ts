import { Type } from "@sinclair/typebox";

import type { CustomTool } from "../extensibility/custom-tools/types";
import type { EventBus } from "../utils/event-bus";
import type { SwarmEventMap } from "../utils/typed-event-map";
import type { SwarmBlackboard } from "./blackboard";

type SwarmEventSink = Pick<EventBus<SwarmEventMap>, "emit">;

export interface SwarmHandoffToolContext {
	active: boolean;
	agent: string;
	sessionId: string;
	currentTaskUri?: string;
	blackboard: SwarmBlackboard;
	eventBus: SwarmEventSink;
}

const handoffSchema = Type.Object({
	context: Type.String({ minLength: 1, description: "Handoff notes for the successor" }),
	target: Type.Optional(Type.String({ minLength: 1, description: "Optional successor target" })),
});

export function createHandoffTool(
	context: SwarmHandoffToolContext,
): CustomTool<typeof handoffSchema, { entryId: string; runId: string; file: string; target: string | null }> {
	return {
		name: "handoff",
		label: "Handoff",
		description: "Record a swarm handoff and emit the handoff signal.",
		parameters: handoffSchema,
		hidden: true,
		execute: async (_toolCallId, params) => {
			if (!context.active) throw new Error("handoff tool is only available in swarm mode");
			const entry = await context.blackboard.write({
				type: "lifecycle",
				agent: context.agent,
				title: params.target ? `Handoff to ${params.target}` : "Handoff",
				body: [
					`Session: ${context.sessionId}`,
					`Agent: ${context.agent}`,
					context.currentTaskUri ? `Task: ${context.currentTaskUri}` : undefined,
					params.target ? `Target: ${params.target}` : undefined,
					"",
					params.context,
				]
					.filter((line): line is string => line !== undefined)
					.join("\n"),
				properties: {
					SESSION_ID: context.sessionId,
					KIND: "handoff",
					...(context.currentTaskUri ? { TASK_URI: context.currentTaskUri } : {}),
					...(params.target ? { TARGET: params.target } : {}),
				},
			});
			context.eventBus.emit("swarm:handoff", {
				fromAgent: context.agent,
				toAgent: params.target,
				context: params.context,
			});
			return {
				content: [{ type: "text", text: `Recorded handoff at ${entry.file}` }],
				details: { entryId: entry.id, runId: entry.runId, file: entry.file, target: params.target ?? null },
				data: null,
			};
		},
	};
}

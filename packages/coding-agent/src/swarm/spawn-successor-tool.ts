import { Type } from "@sinclair/typebox";

import type { CustomTool } from "../extensibility/custom-tools/types";
import type { SwarmNodeLike, SwarmScheduler } from "../task/swarm-scheduler";
import { buildTaskUri, resolveTaskUri } from "./uri";

export interface SwarmSpawnSuccessorToolContext<TNode extends SwarmNodeLike> {
	active: boolean;
	agent: string;
	sessionId: string;
	currentTaskUri: string;
	scheduler: SwarmScheduler<TNode> | null;
}

const spawnSchema = Type.Object({
	slug: Type.String({ minLength: 1, description: "Stable slug for the successor task" }),
	deps: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			description: "Explicit dependencies; omit to depend on the current task",
		}),
	),
});

export function createSpawnSuccessorTool<TNode extends SwarmNodeLike>(
	context: SwarmSpawnSuccessorToolContext<TNode>,
): CustomTool<any, any> {
	return {
		name: "spawn_successor",
		label: "Spawn Successor",
		description: "Add a successor node to the live swarm DAG.",
		parameters: spawnSchema,
		hidden: true,
		execute: async (_toolCallId, params) => {
			if (!context.active) throw new Error("spawn_successor tool is only available in swarm mode");
			if (!context.scheduler) throw new Error("spawn_successor requires a live scheduler");
			const current = resolveTaskUri(context.currentTaskUri, {
				currentSessionId: context.sessionId,
				currentAgentName: context.agent,
			});
			if (!current) throw new Error(`Invalid current task URI: ${context.currentTaskUri}`);
			const deps =
				params.deps === undefined
					? [buildTaskUri(current)]
					: params.deps.length === 0
						? []
						: params.deps.map((dep: string) => {
								const resolved = resolveTaskUri(dep, {
									currentSessionId: context.sessionId,
									currentAgentName: context.agent,
								});
								if (!resolved) throw new Error(`Invalid dependency URI: ${dep}`);
								return buildTaskUri(resolved);
							});
			const nodeUri = buildTaskUri({
				scheme: current.scheme,
				sessionId: current.sessionId,
				agentName: current.agentName,
				slug: params.slug,
			});
			context.scheduler.addNode(nodeUri, { kind: "work", status: "pending" } as TNode, deps);
			return {
				content: [{ type: "text", text: nodeUri }],
				details: { nodeUri, deps },
				data: null,
			};
		},
	};
}

export type EventMap = object;

export type EventChannel<TEventMap extends EventMap> = [keyof TEventMap] extends [never]
	? string
	: string extends keyof TEventMap
		? string
		: Extract<keyof TEventMap, string>;

export type EventPayload<TEventMap extends EventMap, TChannel extends string> = TChannel extends keyof TEventMap
	? TEventMap[TChannel]
	: unknown;

export interface SwarmEventMap {
	"todo:task:created": { taskUri: string; kind: "work" | "data"; slug: string };
	"todo:task:status": { taskUri: string; from: string; to: string };
	"todo:task:blocked": { taskUri: string; blockerUri: string };
	"todo:task:unblocked": { taskUri: string };
	"todo:dag:node_added": { nodeUri: string; deps: string[] };
	"todo:dag:node_removed": { nodeUri: string; cascade: string[] };
	"swarm:artifact": { runId: string; entryId: string; agent: string; dataUri: string; type: string };
	"swarm:handoff": { fromAgent: string; toAgent?: string; context: string };
	"swarm:progress": { agentId: string; progress: number; total: number; label: string };
}

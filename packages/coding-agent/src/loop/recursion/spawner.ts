import type { LoopRetryPolicy, LoopSnapshot, StartLoopOptions } from "../types";
import type { LoopDag } from "./dag";
import { enforceDepthLimit } from "./depth-guard";

export interface SpawnRequest extends StartLoopOptions {
	requiredChild?: boolean;
	failurePolicy?: LoopRetryPolicy;
}

export interface SpawnResult {
	allowed: boolean;
	escalate: boolean;
	reason?: string;
	options?: StartLoopOptions;
}

export class ChildSpawner {
	readonly #dag: LoopDag;
	readonly #depthLimit: number;

	constructor(dag: LoopDag, depthLimit = 3) {
		this.#dag = dag;
		this.#depthLimit = depthLimit;
	}

	prepareChild(parent: LoopSnapshot, request: SpawnRequest): SpawnResult {
		const guard = enforceDepthLimit(parent.depth, this.#depthLimit);
		if (!guard.allowed) {
			return { allowed: false, escalate: guard.escalate, reason: guard.reason };
		}
		if (request.id && this.#dag.createsCycle(parent.id, request.id)) {
			return { allowed: false, escalate: false, reason: `Loop DAG cycle rejected: ${parent.id} -> ${request.id}` };
		}
		return {
			allowed: true,
			escalate: false,
			options: {
				...request,
				parentLoopId: parent.id,
				depth: guard.nextDepth,
			},
		};
	}

	registerChild(parent: LoopSnapshot, childId: string, requiredChild: boolean, failurePolicy: LoopRetryPolicy): void {
		this.#dag.addEdge(parent.id, childId, requiredChild, failurePolicy);
	}
}

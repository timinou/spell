import type { LoopRetryPolicy, LoopTreeEdge } from "../types";

export class LoopDag {
	#edges = new Map<string, LoopTreeEdge[]>();

	addEdge(parentLoopId: string, childLoopId: string, required: boolean, failurePolicy: LoopRetryPolicy): void {
		if (this.createsCycle(parentLoopId, childLoopId)) {
			throw new Error(`Loop DAG cycle rejected: ${parentLoopId} -> ${childLoopId}`);
		}
		const edges = this.#edges.get(parentLoopId) ?? [];
		edges.push({ parentLoopId, childLoopId, required, failurePolicy, attempts: 0 });
		this.#edges.set(parentLoopId, edges);
	}

	childrenOf(loopId: string): LoopTreeEdge[] {
		return structuredClone(this.#edges.get(loopId) ?? []);
	}

	getEdge(parentLoopId: string, childLoopId: string): LoopTreeEdge | undefined {
		return this.childrenOf(parentLoopId).find(edge => edge.childLoopId === childLoopId);
	}

	createsCycle(parentLoopId: string, childLoopId: string): boolean {
		if (parentLoopId === childLoopId) return true;
		const stack = [childLoopId];
		const visited = new Set<string>();
		while (stack.length > 0) {
			const current = stack.pop();
			if (!current || visited.has(current)) continue;
			if (current === parentLoopId) return true;
			visited.add(current);
			for (const edge of this.#edges.get(current) ?? []) {
				stack.push(edge.childLoopId);
			}
		}
		return false;
	}

	topologicalOrder(rootLoopId: string): string[] {
		const ordered: string[] = [];
		const visit = (loopId: string): void => {
			ordered.push(loopId);
			for (const edge of this.#edges.get(loopId) ?? []) {
				visit(edge.childLoopId);
			}
		};
		visit(rootLoopId);
		return ordered;
	}
}

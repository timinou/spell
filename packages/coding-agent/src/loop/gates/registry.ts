import type { LoopGateConfig } from "../types";

function sortGates(left: LoopGateConfig, right: LoopGateConfig): number {
	return (left.priority ?? 0) - (right.priority ?? 0) || left.id.localeCompare(right.id);
}

export class GateRegistry {
	#gates = new Map<string, Map<string, LoopGateConfig>>();

	register(loopId: string, gate: LoopGateConfig): void {
		const gates = this.#gates.get(loopId) ?? new Map<string, LoopGateConfig>();
		if (gates.has(gate.id)) {
			throw new Error(`Duplicate gate id: ${gate.id}`);
		}
		gates.set(gate.id, gate);
		this.#gates.set(loopId, gates);
	}

	unregister(loopId: string, gateId: string): boolean {
		const gates = this.#gates.get(loopId);
		if (!gates) return false;
		return gates.delete(gateId);
	}

	replace(loopId: string, gates: LoopGateConfig[]): void {
		const next = new Map<string, LoopGateConfig>();
		for (const gate of gates) {
			if (next.has(gate.id)) {
				throw new Error(`Duplicate gate id: ${gate.id}`);
			}
			next.set(gate.id, gate);
		}
		this.#gates.set(loopId, next);
	}

	list(loopId: string): LoopGateConfig[] {
		const gates = this.#gates.get(loopId);
		if (!gates) return [];
		return Array.from(gates.values()).sort(sortGates);
	}
}

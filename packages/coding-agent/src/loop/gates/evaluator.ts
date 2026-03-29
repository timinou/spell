import { GATE_OUTCOMES, type GateDecision } from "../contracts";
import type { LoopGateConfig, LoopSnapshot } from "../types";
import { normalizeGateConfigs } from "./config";
import { GateRegistry } from "./registry";
import { type GateTriggerEvent, shouldFire } from "./trigger";
import type { GateExecutionContext, GateExecutor } from "./types";

interface GateEvaluatorOptions {
	executors?: Partial<Record<LoopGateConfig["type"], GateExecutor<LoopGateConfig>>>;
}

export class GateEvaluator {
	readonly #registry = new GateRegistry();
	readonly #executors: Partial<Record<LoopGateConfig["type"], GateExecutor<LoopGateConfig>>>;

	constructor(options: GateEvaluatorOptions = {}) {
		this.#executors = options.executors ?? {};
	}

	register(loopId: string, gate: LoopGateConfig): void {
		this.#registry.register(loopId, gate);
	}

	unregister(loopId: string, gateId: string): boolean {
		return this.#registry.unregister(loopId, gateId);
	}

	configure(loopId: string, gates: LoopGateConfig[]): void {
		this.#registry.replace(loopId, normalizeGateConfigs(gates));
	}

	list(loopId: string): LoopGateConfig[] {
		return this.#registry.list(loopId);
	}

	async evaluate(
		loop: LoopSnapshot,
		event: GateTriggerEvent,
		baseContext: Omit<GateExecutionContext, "loop">,
	): Promise<GateDecision[]> {
		const matching = this.#registry.list(loop.id).filter(gate => shouldFire(gate, event));
		const decisions: GateDecision[] = [];
		for (const gate of matching) {
			const executor = this.#executors[gate.type];
			if (!executor) {
				decisions.push({
					gateId: gate.id,
					trigger: gate.trigger.kind,
					outcome: GATE_OUTCOMES.fail,
					reason: `No executor registered for gate type ${gate.type}`,
					evidence: [],
					attemptNumber: baseContext.attemptNumber,
					maxAttempts: gate.maxAttempts ?? 1,
				});
				continue;
			}
			try {
				decisions.push(await executor.execute(gate, { ...baseContext, loop }));
			} catch (error) {
				decisions.push({
					gateId: gate.id,
					trigger: gate.trigger.kind,
					outcome: GATE_OUTCOMES.fail,
					reason: error instanceof Error ? error.message : String(error),
					evidence: [],
					attemptNumber: baseContext.attemptNumber,
					maxAttempts: gate.maxAttempts ?? 1,
				});
			}
		}
		return decisions;
	}
}

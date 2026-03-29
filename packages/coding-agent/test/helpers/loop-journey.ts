import { expect } from "bun:test";
import { LoopManager } from "../../src/loop/loop-manager";
import type { LoopRoleResponder } from "../../src/loop/orchestration/phase-coordinator";
import type { LoopSnapshot, StartLoopOptions } from "../../src/loop/types";

function createSettings() {
	return {
		getModelRole(role: string) {
			return role === "review" ? "anthropic/claude-sonnet-4-6" : undefined;
		},
	};
}

export class LoopJourney {
	readonly manager: LoopManager;
	readonly responder: LoopRoleResponder;

	constructor(cwd: string, responder: LoopRoleResponder) {
		this.manager = new LoopManager({ cwd, settings: createSettings() });
		this.responder = responder;
	}

	async startLoop(options: StartLoopOptions): Promise<LoopSnapshot> {
		return this.manager.start(options);
	}

	async advanceIteration(loopId: string): Promise<LoopSnapshot> {
		const result = await this.manager.runIteration(loopId, this.responder);
		return result.snapshot;
	}

	expectLoopState(loopId: string, state: LoopSnapshot["state"]): void {
		expect(this.manager.getLoop(loopId).state).toBe(state);
	}

	expectIteration(loopId: string, iteration: number): void {
		expect(this.manager.getLoop(loopId).iteration).toBe(iteration);
	}

	expectGateResult(loopId: string, gateId: string, outcome: LoopSnapshot["gateResults"][number]["outcome"]): void {
		const decision = this.manager.getLoop(loopId).gateResults.find(result => result.gateId === gateId);
		expect(decision?.outcome).toBe(outcome);
	}
}

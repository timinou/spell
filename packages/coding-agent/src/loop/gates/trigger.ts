import { type ChildCompletionSignal, GATE_TRIGGERS, LOOP_STATES } from "../contracts";
import type { LoopGateConfig } from "../types";

export interface GateTriggerEvent {
	iteration: number;
	state: string;
	childSignal?: ChildCompletionSignal;
	ticketCompleted?: string;
}

export function shouldFire(gate: LoopGateConfig, event: GateTriggerEvent): boolean {
	switch (gate.trigger.kind) {
		case GATE_TRIGGERS.everyIteration:
			return event.state === LOOP_STATES.iterating;
		case GATE_TRIGGERS.everyN:
			return (
				gate.trigger.every !== undefined &&
				gate.trigger.every > 0 &&
				event.iteration > 0 &&
				event.iteration % gate.trigger.every === 0
			);
		case GATE_TRIGGERS.onReflection:
			return event.state === LOOP_STATES.reflecting;
		case GATE_TRIGGERS.onCompletion:
			return event.state === LOOP_STATES.validating;
		case GATE_TRIGGERS.onChildComplete:
			return event.childSignal !== undefined;
		case GATE_TRIGGERS.onTicketComplete:
			return event.ticketCompleted !== undefined;
		default:
			return false;
	}
}

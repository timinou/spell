import { logger } from "@oh-my-pi/pi-utils";
import { type EventBus, Priority } from "../../utils/event-bus";
import { highlightFluidCode } from "./code-highlight";
import { FLUID_EVENT_CHANNEL, type FluidEvent } from "./types";

export class FluidEventRouter {
	readonly #eventBus: EventBus;
	#unsubscribe?: () => void;

	constructor(eventBus: EventBus) {
		this.#eventBus = eventBus;
		this.#unsubscribe = this.#eventBus.subscribe(FLUID_EVENT_CHANNEL, (raw: unknown) => {
			const event = raw as FluidEvent;
			const payload = this.toBridgePayload(event);
			this.#eventBus.enqueue("bridge:outbound", payload, Priority.P2, this.#eventKey(event));
		});
	}

	toBridgePayload(event: FluidEvent): Record<string, unknown> {
		switch (event.type) {
			case "plan_start":
				return { type: "fluid:plan_start" };
			case "plan_complete":
				return { type: "fluid:plan_complete", plan: event.plan };
			case "plan_error":
				return { type: "fluid:plan_error", error: event.error };
			case "agent_state_change":
				return {
					type: "fluid:agent_state_change",
					agentId: event.agentId,
					state: event.state,
					result: event.result,
					error: event.error,
					startedAt: event.startedAt,
					completedAt: event.completedAt,
				};
			case "planner_stream":
				return { type: "fluid:planner_stream", text: event.text };
			case "agent_stream":
				return { type: "fluid:agent_stream", agentId: event.agentId, text: event.text };
			case "canvas_output":
				return {
					type: "fluid:canvas_output",
					agentId: event.agentId,
					outputType: event.outputType,
					title: event.title,
					content: event.outputType === "code" ? highlightFluidCode(event.content) : event.content,
				};
			case "execution_cancelled":
				return { type: "fluid:execution_cancelled", reason: event.reason };
			case "execution_complete":
				return {
					type: "fluid:execution_complete",
					results: [...event.results.entries()].map(([agentId, runtime]) => ({
						agentId,
						state: runtime.state,
						error: runtime.error,
						result: runtime.result,
						startedAt: runtime.startedAt,
						completedAt: runtime.completedAt,
					})),
				};
			default:
				logger.warn("Unknown fluid event", { eventType: (event as { type?: string }).type });
				return { type: "fluid:unknown" };
		}
	}

	dispose(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
	}

	#eventKey(event: FluidEvent): string {
		switch (event.type) {
			case "agent_stream":
				return `${event.type}:${event.agentId}`;
			case "agent_state_change":
				return `${event.type}:${event.agentId}:${event.state}`;
			case "canvas_output":
				return `${event.type}:${event.agentId}:${event.outputType}`;
			default:
				return event.type;
		}
	}
}

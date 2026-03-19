import type { SingleResult } from "../../task/types";
import { type EventBus, Priority } from "../../utils/event-bus";
import { validateDag } from "./dag";
import { QueueScheduler, type RunAgentFn } from "./queue-scheduler";
import { type AgentRuntime, FLUID_EVENT_CHANNEL, type FluidAgentNode, type FluidPlan } from "./types";

interface FluidOrchestratorOptions {
	eventBus: EventBus;
	cwd: string;
	concurrency?: number;
	runAgent?: RunAgentFn;
}

const defaultRunAgent: RunAgentFn = async (
	_node: FluidAgentNode,
	_upstream: Map<string, SingleResult>,
	_signal?: AbortSignal,
) => {
	throw new Error("FluidOrchestrator requires runAgent to be provided");
};

export class FluidOrchestrator {
	readonly #eventBus: EventBus;
	readonly #cwd: string;
	readonly #concurrency: number;
	readonly #runAgent: RunAgentFn;
	#draining = false;
	#drainTimer?: NodeJS.Timeout;

	constructor(options: FluidOrchestratorOptions) {
		this.#eventBus = options.eventBus;
		this.#cwd = options.cwd;
		this.#concurrency = Math.max(1, options.concurrency ?? 5);
		this.#runAgent = options.runAgent ?? defaultRunAgent;
	}

	async execute(
		plan: FluidPlan,
		signal?: AbortSignal,
		presetCompletedResults?: Map<string, SingleResult>,
	): Promise<Map<string, AgentRuntime>> {
		void this.#cwd;
		const validation = validateDag(plan);
		if (!validation.valid) {
			const error = validation.errors.join("; ");
			this.#eventBus.enqueue(FLUID_EVENT_CHANNEL, { type: "plan_error", error }, Priority.P1);
			throw new Error(error);
		}
		this.#eventBus.enqueue(FLUID_EVENT_CHANNEL, { type: "plan_complete", plan }, Priority.P1);
		const planAgentsById = new Map(plan.agents.map(agent => [agent.id, agent]));

		this.#startDrainTimer();
		try {
			const scheduler = new QueueScheduler({
				concurrency: this.#concurrency,
				runAgent: this.#runAgent,
				signal,
				presetCompletedResults,
				onEvent: event => {
					this.#eventBus.enqueue(FLUID_EVENT_CHANNEL, event, Priority.P1);
					if (event.type !== "agent_state_change" || event.state !== "completed" || !event.result) {
						return;
					}
					const node = planAgentsById.get(event.agentId);
					if (!node?.canvasOutput) {
						return;
					}
					this.#eventBus.enqueue(
						FLUID_EVENT_CHANNEL,
						{
							type: "canvas_output",
							agentId: event.agentId,
							outputType: node.canvasOutput.type,
							title: node.canvasOutput.title,
							content: event.result.output,
						},
						Priority.P1,
					);
				},
			});

			const results = await scheduler.execute(plan);
			return results;
		} finally {
			this.#stopDrainTimer();
		}
	}

	#startDrainTimer(): void {
		this.#drainTimer = setInterval(async () => {
			if (this.#draining) return;
			this.#draining = true;
			try {
				await this.#eventBus.drain();
			} finally {
				this.#draining = false;
			}
		}, 100);
	}

	#stopDrainTimer(): void {
		if (this.#drainTimer) {
			clearInterval(this.#drainTimer);
			this.#drainTimer = undefined;
		}
	}
}

import type { Semaphore } from "../../task/parallel";
import type { SingleResult } from "../../task/types";
import { getReadyAgents } from "./dag";
import type { AgentRuntime, FluidAgentNode, FluidEvent, FluidPlan } from "./types";

export type RunAgentFn = (
	node: FluidAgentNode,
	upstreamResults: Map<string, SingleResult>,
	signal?: AbortSignal,
) => Promise<SingleResult>;

interface QueueSchedulerOptions {
	concurrency: number;
	runAgent: RunAgentFn;
	onEvent?: (event: FluidEvent) => void;
	signal?: AbortSignal;
	presetCompletedResults?: Map<string, SingleResult>;
	/** Global semaphore shared across schedulers for cross-coordinator concurrency control. */
	semaphore?: Semaphore;
}

export class QueueScheduler {
	readonly #concurrency: number;
	readonly #runAgent: RunAgentFn;
	readonly #onEvent?: (event: FluidEvent) => void;
	readonly #signal?: AbortSignal;
	readonly #presetCompletedResults?: Map<string, SingleResult>;
	readonly #semaphore?: Semaphore;

	constructor(options: QueueSchedulerOptions) {
		this.#concurrency = Math.max(1, options.concurrency);
		this.#runAgent = options.runAgent;
		this.#onEvent = options.onEvent;
		this.#signal = options.signal;
		this.#presetCompletedResults = options.presetCompletedResults;
		this.#semaphore = options.semaphore;
	}
	async execute(plan: FluidPlan): Promise<Map<string, AgentRuntime>> {
		const runtimes = new Map<string, AgentRuntime>();
		const nodeById = new Map<string, FluidAgentNode>();
		const readyQueue: string[] = [];
		const queued = new Set<string>();
		const completed = new Set<string>();
		const failed = new Set<string>();
		const running = new Set<string>();

		for (const node of plan.agents) {
			nodeById.set(node.id, node);
			const presetResult = this.#presetCompletedResults?.get(node.id);
			if (presetResult) {
				const completedAt = Date.now();
				runtimes.set(node.id, { node, state: "completed", result: presetResult, completedAt });
				completed.add(node.id);
				this.#onEvent?.({
					type: "agent_state_change",
					agentId: node.id,
					state: "completed",
					result: presetResult,
					completedAt,
				});
				continue;
			}
			if (node.deferred) {
				const completedAt = Date.now();
				runtimes.set(node.id, {
					node,
					state: "completed",
					result: {
						index: 0,
						id: node.id,
						agent: "deferred",
						agentSource: "bundled",
						task: node.task,
						exitCode: 0,
						output: "Deferred (FUP item — skipped)",
						stderr: "",
						truncated: false,
						durationMs: 0,
						tokens: 0,
					},
					completedAt,
				});
				completed.add(node.id);
				this.#onEvent?.({
					type: "agent_state_change",
					agentId: node.id,
					state: "completed",
					result: runtimes.get(node.id)!.result,
					completedAt,
				});
				continue;
			}
			runtimes.set(node.id, { node, state: "pending" });
		}

		const initialReady = getReadyAgents(plan, completed);
		for (const id of initialReady) {
			const runtime = runtimes.get(id);
			if (!runtime || runtime.state !== "pending") {
				continue;
			}
			runtime.state = "ready";
			queued.add(id);
			readyQueue.push(id);
			this.#onEvent?.({ type: "agent_state_change", agentId: id, state: "ready" });
		}

		const completion = Promise.withResolvers<Map<string, AgentRuntime>>();
		const maybeFinish = (): void => {
			if (running.size > 0) {
				return;
			}
			if (completed.size + failed.size !== plan.agents.length) {
				return;
			}
			this.#onEvent?.({ type: "execution_complete", results: runtimes });
			completion.resolve(runtimes);
		};

		const markFailedBlockedDependents = (): void => {
			for (const node of plan.agents) {
				const runtime = runtimes.get(node.id);
				if (!runtime || runtime.state === "completed" || runtime.state === "failed") {
					continue;
				}
				if (node.dependsOn.some(dep => failed.has(dep))) {
					runtime.state = "failed";
					runtime.completedAt = Date.now();
					runtime.error = "Dependency failed";
					failed.add(node.id);
					queued.delete(node.id);
					this.#onEvent?.({
						type: "agent_state_change",
						agentId: node.id,
						state: "failed",
						error: runtime.error,
						completedAt: runtime.completedAt,
					});
				}
			}
		};

		const enqueueNewReady = (): void => {
			const ready = getReadyAgents(plan, completed);
			for (const id of ready) {
				if (queued.has(id) || completed.has(id) || failed.has(id) || running.has(id)) {
					continue;
				}
				const runtime = runtimes.get(id);
				if (!runtime || runtime.state !== "pending") {
					continue;
				}
				runtime.state = "ready";
				queued.add(id);
				readyQueue.push(id);
				this.#onEvent?.({ type: "agent_state_change", agentId: id, state: "ready" });
			}
		};

		const dispatch = (): void => {
			if (this.#signal?.aborted) {
				completion.reject(new Error("Fluid execution aborted"));
				return;
			}

			while (running.size < this.#concurrency && readyQueue.length > 0) {
				const id = readyQueue.shift();
				if (!id) {
					continue;
				}
				queued.delete(id);

				const node = nodeById.get(id);
				const runtime = runtimes.get(id);
				if (!node || !runtime || runtime.state !== "ready") {
					continue;
				}

				runtime.state = "running";
				runtime.startedAt = Date.now();
				running.add(id);
				this.#onEvent?.({
					type: "agent_state_change",
					agentId: id,
					state: "running",
					startedAt: runtime.startedAt,
				});

				const upstreamResults = new Map<string, SingleResult>();
				for (const dep of node.dependsOn) {
					const depResult = runtimes.get(dep)?.result;
					if (depResult) {
						upstreamResults.set(dep, depResult);
					}
				}

				const executeAgent = async (): Promise<SingleResult> => {
					if (this.#semaphore) await this.#semaphore.acquire();
					try {
						return await this.#runAgent(node, upstreamResults, this.#signal);
					} finally {
						this.#semaphore?.release();
					}
				};

				void executeAgent()
					.then(result => {
						runtime.state = "completed";
						runtime.result = result;
						runtime.completedAt = Date.now();
						completed.add(id);
						this.#onEvent?.({
							type: "agent_state_change",
							agentId: id,
							state: "completed",
							result,
							startedAt: runtime.startedAt,
							completedAt: runtime.completedAt,
						});
					})
					.catch(err => {
						runtime.state = "failed";
						runtime.completedAt = Date.now();
						runtime.error = err instanceof Error ? err.message : String(err);
						failed.add(id);
						this.#onEvent?.({
							type: "agent_state_change",
							agentId: id,
							state: "failed",
							error: runtime.error,
							startedAt: runtime.startedAt,
							completedAt: runtime.completedAt,
						});
					})
					.finally(() => {
						running.delete(id);
						markFailedBlockedDependents();
						enqueueNewReady();
						dispatch();
						maybeFinish();
					});
			}
		};

		if (this.#signal) {
			this.#signal.addEventListener(
				"abort",
				() => {
					completion.reject(new Error("Fluid execution aborted"));
				},
				{ once: true },
			);
		}

		dispatch();
		maybeFinish();
		return completion.promise;
	}
}

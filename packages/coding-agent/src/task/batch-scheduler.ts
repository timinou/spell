export interface BatchTask<T> {
	id: string;
	blockers?: string[];
	run: (signal: AbortSignal) => Promise<T>;
}

export interface BatchTaskResult<T> {
	id: string;
	status: "completed" | "failed" | "aborted";
	result?: T;
	error?: string;
}

export interface BatchSchedulerOptions {
	maxConcurrency: number;
	signal?: AbortSignal;
	/** Delay between sibling launches for prompt cache warming (ms). 0 to disable. */
	staggerMs?: number;
}

export interface BatchGraph {
	order: string[];
	indexById: Map<string, number>;
	blockersById: Map<string, string[]>;
	dependentsById: Map<string, string[]>;
}

function normalizeBlockers(blockers: string[] | undefined): string[] {
	if (!blockers?.length) return [];
	return Array.from(new Set(blockers.filter(Boolean)));
}

function clampConcurrency(maxConcurrency: number, taskCount: number): number {
	const normalized = Number.isFinite(maxConcurrency) ? Math.floor(maxConcurrency) : taskCount;
	const effective = normalized > 0 ? normalized : taskCount;
	return Math.max(1, Math.min(effective, taskCount));
}

function formatSchedulerErrors(errors: string[]): Error {
	return new Error(errors.join("; "));
}

export function buildBatchGraph(tasks: Array<Pick<BatchTask<unknown>, "id" | "blockers">>): BatchGraph {
	const indexById = new Map<string, number>();
	const blockersById = new Map<string, string[]>();
	const dependentsById = new Map<string, string[]>();
	const errors: string[] = [];

	for (const [index, task] of tasks.entries()) {
		indexById.set(task.id, index);
		dependentsById.set(task.id, []);
	}

	for (const task of tasks) {
		const blockers = normalizeBlockers(task.blockers);
		blockersById.set(task.id, blockers);
		for (const blockerId of blockers) {
			if (!indexById.has(blockerId)) {
				errors.push(`Task ${task.id} depends on missing blocker ${blockerId}`);
				continue;
			}
			if (blockerId === task.id) {
				errors.push(`Task ${task.id} cannot block on itself`);
				continue;
			}
			dependentsById.get(blockerId)?.push(task.id);
		}
	}

	if (errors.length > 0) {
		throw formatSchedulerErrors(errors);
	}

	const remainingBlockers = new Map<string, number>();
	const queue: string[] = [];
	for (const task of tasks) {
		const blockers = blockersById.get(task.id) ?? [];
		remainingBlockers.set(task.id, blockers.length);
		if (blockers.length === 0) {
			queue.push(task.id);
		}
	}

	const order: string[] = [];
	for (let index = 0; index < queue.length; index++) {
		const currentId = queue[index];
		order.push(currentId);
		for (const dependentId of dependentsById.get(currentId) ?? []) {
			const nextCount = (remainingBlockers.get(dependentId) ?? 0) - 1;
			remainingBlockers.set(dependentId, nextCount);
			if (nextCount === 0) {
				queue.push(dependentId);
			}
		}
	}

	if (order.length !== tasks.length) {
		throw new Error("Task batch contains dependency cycles");
	}

	return { order, indexById, blockersById, dependentsById };
}

export async function scheduleBatch<T>(
	tasks: BatchTask<T>[],
	options: BatchSchedulerOptions,
): Promise<BatchTaskResult<T>[]> {
	if (tasks.length === 0) return [];

	const graph = buildBatchGraph(tasks);
	const limit = clampConcurrency(options.maxConcurrency, tasks.length);
	const signal = options.signal ?? new AbortController().signal;
	const staggerMs = options.staggerMs ?? 0;
	const runningIds = new Set<string>();
	const resultsById = new Map<string, BatchTaskResult<T>>();
	const remainingBlockers = new Map<string, number>();
	const readyQueue: string[] = [];
	const { promise, resolve } = Promise.withResolvers<void>();
	let launchCount = 0;

	for (const task of tasks) {
		const blockers = graph.blockersById.get(task.id) ?? [];
		remainingBlockers.set(task.id, blockers.length);
		if (blockers.length === 0) {
			readyQueue.push(task.id);
		}
	}

	const finishTask = (id: string, result: BatchTaskResult<T>): void => {
		if (resultsById.has(id)) return;
		resultsById.set(id, result);
		if (resultsById.size === tasks.length) {
			resolve();
		}
	};

	const failDependents = (failedPredecessorId: string): void => {
		const queue = [...(graph.dependentsById.get(failedPredecessorId) ?? [])];
		const seen = new Set<string>();
		while (queue.length > 0) {
			const dependentId = queue.shift();
			if (!dependentId || seen.has(dependentId)) continue;
			seen.add(dependentId);
			if (runningIds.has(dependentId) || resultsById.has(dependentId)) continue;
			finishTask(dependentId, {
				id: dependentId,
				status: "failed",
				error: `Predecessor ${failedPredecessorId} failed`,
			});
			queue.push(...(graph.dependentsById.get(dependentId) ?? []));
		}
	};

	const abortPendingTasks = (): void => {
		for (const task of tasks) {
			if (resultsById.has(task.id) || runningIds.has(task.id)) continue;
			finishTask(task.id, {
				id: task.id,
				status: "aborted",
				error: "Cancelled before start",
			});
		}
	};

	const pump = (): void => {
		while (!signal.aborted && runningIds.size < limit && readyQueue.length > 0) {
			const nextId = readyQueue.shift();
			if (!nextId || resultsById.has(nextId)) continue;
			runningIds.add(nextId);
			void (async () => {
				// Stagger sibling launches for prompt cache warming
				const myLaunchIndex = launchCount++;
				if (staggerMs > 0 && myLaunchIndex > 0) {
					await Bun.sleep(staggerMs * myLaunchIndex);
					if (signal.aborted) return;
				}
				const taskIndex = graph.indexById.get(nextId);
				if (taskIndex === undefined) {
					runningIds.delete(nextId);
					finishTask(nextId, { id: nextId, status: "failed", error: `Task ${nextId} missing from batch graph` });
					return;
				}
				const task = tasks[taskIndex];
				try {
					const result = await task.run(signal);
					finishTask(nextId, { id: nextId, status: "completed", result });
					if (!signal.aborted) {
						for (const dependentId of graph.dependentsById.get(nextId) ?? []) {
							if (resultsById.has(dependentId)) continue;
							const nextCount = (remainingBlockers.get(dependentId) ?? 0) - 1;
							remainingBlockers.set(dependentId, nextCount);
							if (nextCount === 0) {
								readyQueue.push(dependentId);
							}
						}
					}
				} catch (error) {
					const errorText = error instanceof Error ? error.message : String(error);
					if (signal.aborted) {
						finishTask(nextId, {
							id: nextId,
							status: "aborted",
							error: errorText || "Aborted",
						});
					} else {
						finishTask(nextId, {
							id: nextId,
							status: "failed",
							error: errorText,
						});
						failDependents(nextId);
					}
				} finally {
					runningIds.delete(nextId);
					if (signal.aborted) {
						abortPendingTasks();
					}
					pump();
				}
			})();
		}

		if (signal.aborted) {
			abortPendingTasks();
		}

		if (resultsById.size === tasks.length) {
			resolve();
		}
	};

	if (signal.aborted) {
		abortPendingTasks();
	} else {
		signal.addEventListener("abort", abortPendingTasks, { once: true });
	}

	pump();
	await promise;

	return graph.order
		.map(id => resultsById.get(id)!)
		.sort((a, b) => {
			const aIndex = graph.indexById.get(a.id) ?? 0;
			const bIndex = graph.indexById.get(b.id) ?? 0;
			return aIndex - bIndex;
		});
}

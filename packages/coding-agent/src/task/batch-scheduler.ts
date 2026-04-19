import { SwarmScheduler } from "./swarm-scheduler";

export interface BatchTask<T> {
	id: string;
	blockers?: string[];
	/**
	 * Absolute or cwd-relative paths this task may mutate. Two batch tasks
	 * that declare overlapping filesDeps will not be in-flight concurrently,
	 * independent of isolationMode. Tasks that declare no filesDeps are
	 * treated as touching everything and serialize against all running
	 * neighbors.
	 */
	filesDeps?: string[];
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
	staggerMs?: number;
}
export interface BatchGraph {
	order: string[];
	indexById: Map<string, number>;
	blockersById: Map<string, string[]>;
	dependentsById: Map<string, string[]>;
}
function normalizeBlockers(blockers: string[] | undefined): string[] {
	return blockers?.length ? Array.from(new Set(blockers.filter(Boolean))) : [];
}
function clampConcurrency(maxConcurrency: number, taskCount: number): number {
	const normalized = Number.isFinite(maxConcurrency) ? Math.floor(maxConcurrency) : taskCount;
	return Math.max(1, Math.min(normalized > 0 ? normalized : taskCount, taskCount));
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
			if (!indexById.has(blockerId)) errors.push(`Task ${task.id} depends on missing blocker ${blockerId}`);
			else if (blockerId === task.id) errors.push(`Task ${task.id} cannot block on itself`);
			else dependentsById.get(blockerId)?.push(task.id);
		}
	}
	if (errors.length > 0) throw formatSchedulerErrors(errors);
	const remaining = new Map<string, number>();
	const queue: string[] = [];
	for (const task of tasks) {
		const blockers = blockersById.get(task.id) ?? [];
		remaining.set(task.id, blockers.length);
		if (blockers.length === 0) queue.push(task.id);
	}
	const order: string[] = [];
	for (let index = 0; index < queue.length; index++) {
		const current = queue[index];
		order.push(current);
		for (const dependentId of dependentsById.get(current) ?? []) {
			const next = (remaining.get(dependentId) ?? 0) - 1;
			remaining.set(dependentId, next);
			if (next === 0) queue.push(dependentId);
		}
	}
	if (order.length !== tasks.length) throw new Error("Task batch contains dependency cycles");
	return { order, indexById, blockersById, dependentsById };
}
export async function scheduleBatch<T>(
	tasks: BatchTask<T>[],
	options: BatchSchedulerOptions,
): Promise<BatchTaskResult<T>[]> {
	if (tasks.length === 0) return [];
	const graph = buildBatchGraph(tasks);
	const scheduler = new SwarmScheduler(
		tasks.map(
			task =>
				[task.id, { kind: "work", status: "pending", filesDeps: task.filesDeps } as const, task.blockers] as [
					string,
					{ kind: "work"; status: "pending"; filesDeps?: string[] },
					string[]?,
				],
		),
		{ maxConcurrency: clampConcurrency(options.maxConcurrency, tasks.length) },
	);
	const signal = options.signal ?? new AbortController().signal;
	const staggerMs = options.staggerMs ?? 0;
	const results = new Map<string, BatchTaskResult<T>>();
	let launchIndex = 0;
	const finish = (id: string, result: BatchTaskResult<T>): void => {
		if (!results.has(id)) results.set(id, result);
	};
	const failDependents = (failedPredecessorId: string): void => {
		const queue = [...(graph.dependentsById.get(failedPredecessorId) ?? [])];
		const seen = new Set<string>();
		while (queue.length > 0) {
			const dependentId = queue.shift();
			if (!dependentId || seen.has(dependentId)) continue;
			seen.add(dependentId);
			if (results.has(dependentId)) continue;
			finish(dependentId, { id: dependentId, status: "failed", error: `Predecessor ${failedPredecessorId} failed` });
			queue.push(...(graph.dependentsById.get(dependentId) ?? []));
		}
	};
	await scheduler.pump(async (id, _node, runSignal) => {
		const task = tasks[graph.indexById.get(id) ?? 0];
		try {
			const myLaunchIndex = launchIndex++;
			if (staggerMs > 0 && myLaunchIndex > 0) {
				await Bun.sleep(staggerMs * myLaunchIndex);
				if (runSignal.aborted) throw new Error("Aborted during stagger delay");
			}
			const result = await task.run(runSignal);
			finish(id, { id, status: "completed", result });
			scheduler.markCompleted(id);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (runSignal.aborted) finish(id, { id, status: "aborted", error: message || "Aborted" });
			else {
				finish(id, { id, status: "failed", error: message });
				scheduler.markFailed(id);
				failDependents(id);
			}
		}
	}, signal);
	for (const task of tasks)
		if (!results.has(task.id)) finish(task.id, { id: task.id, status: "aborted", error: "Cancelled before start" });
	return graph.order
		.map(id => results.get(id)!)
		.sort((a, b) => (graph.indexById.get(a.id) ?? 0) - (graph.indexById.get(b.id) ?? 0));
}

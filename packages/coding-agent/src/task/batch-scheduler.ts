import { findOverlappingFilesDep, MutableDag } from "./mutable-dag";
import { SwarmScheduler } from "./swarm-scheduler";

type BatchGraphNode = {
	filesDeps?: string[];
};

export interface BatchTask<T> {
	id: string;
	blockers?: string[];
	/**
	 * Absolute or cwd-relative paths this task may mutate. Overlapping filesDeps
	 * are rewritten into declaration-ordered blocker edges before execution.
	 * Tasks that declare no filesDeps contribute no overlap constraints.
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
export interface BatchImplicitBlocker {
	to: string;
	from: string;
	reason: string;
}
export interface BatchGraph {
	order: string[];
	indexById: Map<string, number>;
	blockersById: Map<string, string[]>;
	dependentsById: Map<string, string[]>;
	implicitBlockers: BatchImplicitBlocker[];
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
function normalizeBatchGraphError(error: unknown, context?: string): Error {
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes("contains dependency cycles")) {
		return new Error(
			context ? `Task batch contains dependency cycles: ${context}` : "Task batch contains dependency cycles",
		);
	}
	return new Error(context ? `${context}: ${message}` : message);
}
function buildDag(tasks: Array<Pick<BatchTask<unknown>, "id" | "blockers" | "filesDeps">>): MutableDag<BatchGraphNode> {
	try {
		const dag = new MutableDag(
			tasks.map(task => [task.id, { filesDeps: task.filesDeps }] as [string, BatchGraphNode]),
		);
		for (const task of tasks) {
			dag.setDependencies(task.id, normalizeBlockers(task.blockers));
		}
		return dag;
	} catch (error) {
		throw normalizeBatchGraphError(error);
	}
}
function buildDependencyMaps(
	tasks: Array<Pick<BatchTask<unknown>, "id">>,
	dag: MutableDag<BatchGraphNode>,
): Pick<BatchGraph, "blockersById" | "dependentsById"> {
	return {
		blockersById: new Map(tasks.map(task => [task.id, dag.getDependencies(task.id)])),
		dependentsById: new Map(tasks.map(task => [task.id, dag.getDependents(task.id)])),
	};
}
export function buildBatchGraph(tasks: Array<Pick<BatchTask<unknown>, "id" | "blockers" | "filesDeps">>): BatchGraph {
	const indexById = new Map<string, number>();
	const errors: string[] = [];
	for (const [index, task] of tasks.entries()) {
		indexById.set(task.id, index);
	}
	for (const task of tasks) {
		for (const blockerId of normalizeBlockers(task.blockers)) {
			if (!indexById.has(blockerId)) errors.push(`Task ${task.id} depends on missing blocker ${blockerId}`);
			else if (blockerId === task.id) errors.push(`Task ${task.id} cannot block on itself`);
		}
	}
	if (errors.length > 0) throw formatSchedulerErrors(errors);
	const dag = buildDag(tasks);
	const implicitBlockers: BatchImplicitBlocker[] = [];
	for (let leftIndex = 0; leftIndex < tasks.length; leftIndex++) {
		const leftTask = tasks[leftIndex];
		for (let rightIndex = leftIndex + 1; rightIndex < tasks.length; rightIndex++) {
			const rightTask = tasks[rightIndex];
			if (!dag.hasFileOverlap(leftTask.id, rightTask.id)) continue;
			if (dag.getDependencies(rightTask.id).includes(leftTask.id)) continue;
			const reason =
				findOverlappingFilesDep(leftTask.filesDeps, rightTask.filesDeps) ??
				rightTask.filesDeps?.[0] ??
				leftTask.filesDeps?.[0] ??
				leftTask.id;
			try {
				dag.addEdge(leftTask.id, rightTask.id);
			} catch (error) {
				throw normalizeBatchGraphError(
					error,
					`Task ${rightTask.id} cannot add implicit blocker ${leftTask.id} for filesDeps overlap (${reason})`,
				);
			}
			implicitBlockers.push({ to: rightTask.id, from: leftTask.id, reason });
		}
	}
	const { blockersById, dependentsById } = buildDependencyMaps(tasks, dag);
	return { order: dag.topologicalOrder(), indexById, blockersById, dependentsById, implicitBlockers };
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
				[
					task.id,
					{ kind: "work", status: "pending", filesDeps: task.filesDeps } as const,
					graph.blockersById.get(task.id),
				] as [string, { kind: "work"; status: "pending"; filesDeps?: string[] }, string[]?],
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

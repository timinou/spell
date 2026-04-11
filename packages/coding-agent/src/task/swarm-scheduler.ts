import { MutableDag, type MutableDagRemovalMode } from "./mutable-dag";

export type SwarmNodeKind = "work" | "data";
export type SwarmNodeStatus =
	| "pending"
	| "in_progress"
	| "completed"
	| "failed"
	| "aborted"
	| "gate_failed"
	| "abandoned";

export interface SwarmNodeLike {
	kind?: SwarmNodeKind;
	status?: SwarmNodeStatus;
	filesDeps?: string[];
	dataContent?: string;
	artifactPath?: string;
}

export interface SwarmSchedulerOptions {
	maxConcurrency?: number;
	isolationMode?: boolean;
}

export interface SwarmSchedulerPumpResult {
	started: string[];
	completed: string[];
	failed: string[];
	aborted: string[];
}

function isTerminal(status: SwarmNodeStatus | undefined): boolean {
	return (
		status === "completed" ||
		status === "failed" ||
		status === "aborted" ||
		status === "gate_failed" ||
		status === "abandoned"
	);
}

function isSatisfiedDataNode(node: SwarmNodeLike): boolean {
	return (
		(node.kind ?? "work") === "data" && Boolean(node.dataContent || node.artifactPath || node.status === "completed")
	);
}

function normalizeFiles(files: string[] | undefined): string[] {
	return files?.length ? Array.from(new Set(files.filter(Boolean))) : [];
}

function formatFailureReason(id: string): string {
	return `Predecessor ${id} failed`;
}

export class SwarmScheduler<T extends SwarmNodeLike> {
	#dag: MutableDag<T>;
	#maxConcurrency: number;
	#isolationMode: boolean;

	constructor(entries: Array<[string, T, string[]?]> = [], options: SwarmSchedulerOptions = {}) {
		this.#dag = new MutableDag(entries);
		this.#maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency ?? 1));
		this.#isolationMode = options.isolationMode ?? false;
	}

	get dag(): MutableDag<T> {
		return this.#dag;
	}

	addNode(id: string, data: T, dependsOn: string[] = []): void {
		this.#dag.addNode(id, data, dependsOn);
	}

	setNode(id: string, data: T): void {
		this.#dag.setNode(id, data);
	}

	setDependencies(id: string, dependsOn: string[]): void {
		this.#dag.setDependencies(id, dependsOn);
	}

	removeNode(id: string, mode: MutableDagRemovalMode = "cascade"): void {
		this.#dag.removeNode(id, mode);
	}

	markCompleted(id: string): void {
		const node = this.#dag.getNode(id);
		if (!node) return;
		this.#dag.setNode(id, { ...node, status: "completed" });
	}

	markFailed(id: string): void {
		const node = this.#dag.getNode(id);
		if (!node) return;
		this.#dag.setNode(id, { ...node, status: "failed" });
		this.#cascadeFailure(id);
	}

	satisfyDataNode(id: string, patch: Pick<SwarmNodeLike, "dataContent" | "artifactPath">): void {
		const node = this.#dag.getNode(id);
		if (!node) return;
		this.#dag.setNode(id, { ...node, ...patch, status: "completed" });
	}

	getReadyNodeIds(): string[] {
		const completed = new Set<string>();
		for (const id of this.#dag.topologicalOrder()) {
			const node = this.#dag.getNode(id);
			if (!node) continue;
			if (node.status === "completed" || node.status === "abandoned" || isSatisfiedDataNode(node)) completed.add(id);
		}
		return this.#dag.getReadyNodeIds(completed).filter(id => {
			const node = this.#dag.getNode(id);
			return node ? node.status === undefined || node.status === "pending" || node.status === "in_progress" : false;
		});
	}

	async pump(
		runNode: (id: string, node: T, signal: AbortSignal) => Promise<void>,
		signal?: AbortSignal,
	): Promise<SwarmSchedulerPumpResult> {
		const abortController = new AbortController();
		const effectiveSignal = signal ?? abortController.signal;
		const started: string[] = [];
		const completed: string[] = [];
		const failed: string[] = [];
		const aborted: string[] = [];
		const running = new Set<string>();
		const inFlight = new Map<string, Promise<void>>();

		const markTerminal = (id: string, status: SwarmNodeStatus): void => {
			const node = this.#dag.getNode(id);
			if (!node || isTerminal(node.status)) return;
			this.#dag.setNode(id, { ...node, status });
			if (status === "completed") completed.push(id);
			if (status === "failed") failed.push(id);
			if (status === "aborted") aborted.push(id);
		};

		const canRun = (id: string): boolean => {
			if (!this.#isolationMode) return true;
			const candidate = this.#dag.getNode(id);
			if (!candidate) return false;
			const candidateFiles = normalizeFiles(candidate.filesDeps);
			for (const activeId of running) {
				const active = this.#dag.getNode(activeId);
				if (!active) continue;
				const activeFiles = normalizeFiles(active.filesDeps);
				if (candidateFiles.length === 0 || activeFiles.length === 0) return false;
				if (this.#dag.hasFileOverlap(id, activeId)) return false;
			}
			return true;
		};

		const cascadePendingAbort = (): void => {
			for (const id of this.#dag.topologicalOrder()) {
				const node = this.#dag.getNode(id);
				if (!node || running.has(id) || inFlight.has(id) || isTerminal(node.status) || node.status === "completed")
					continue;
				markTerminal(id, "aborted");
			}
		};

		const pump = (): void => {
			if (effectiveSignal.aborted) return;
			const ready = this.getReadyNodeIds();
			for (const id of ready) {
				if (running.size >= this.#maxConcurrency) break;
				if (running.has(id) || inFlight.has(id) || !canRun(id)) continue;
				const node = this.#dag.getNode(id);
				if (!node) continue;
				running.add(id);
				started.push(id);
				const promise = runNode(id, node, effectiveSignal)
					.then(() => {
						if (!effectiveSignal.aborted) markTerminal(id, "completed");
					})
					.catch(error => {
						const message = error instanceof Error ? error.message : String(error);
						if (effectiveSignal.aborted) {
							markTerminal(id, "aborted");
							return;
						}
						markTerminal(id, "failed");
						this.#cascadeFailure(id, message);
					})
					.finally(() => {
						running.delete(id);
						inFlight.delete(id);
					});
				inFlight.set(id, promise);
			}
		};

		if (effectiveSignal.aborted) {
			cascadePendingAbort();
			return { started, completed, failed, aborted };
		}

		while (true) {
			pump();
			if (inFlight.size === 0) break;
			await Promise.race(inFlight.values()).catch(() => undefined);
			if (effectiveSignal.aborted) {
				cascadePendingAbort();
				break;
			}
		}

		if (effectiveSignal.aborted) cascadePendingAbort();
		return { started, completed, failed, aborted };
	}

	#cascadeFailure(id: string, reason = formatFailureReason(id)): void {
		for (const dependentId of this.#dag.getDependents(id)) {
			const dependent = this.#dag.getNode(dependentId);
			if (!dependent || isTerminal(dependent.status)) continue;
			this.#dag.setNode(dependentId, { ...dependent, status: "failed" });
			void reason;
			this.#cascadeFailure(dependentId, reason);
		}
	}
}

import type { WorkflowStore } from "./store";
import type {
	WorkflowAuditEntry,
	WorkflowDownstreamAttempt,
	WorkflowDownstreamJob,
	WorkflowDownstreamSpec,
} from "./types";

export interface DownstreamQueueConfig {
	globalLimit?: number;
	perKindLimit?: Record<string, number>;
}

export interface DownstreamQueueDependencies {
	store: WorkflowStore;
	now?: () => Date;
	onAudit?: (entry: WorkflowAuditEntry) => void;
	config?: DownstreamQueueConfig;
}

export class DownstreamQueue {
	#store: WorkflowStore;
	#now: () => Date;
	#onAudit?: (entry: WorkflowAuditEntry) => void;
	#config: DownstreamQueueConfig;

	constructor(dependencies: DownstreamQueueDependencies) {
		this.#store = dependencies.store;
		this.#now = dependencies.now ?? (() => new Date());
		this.#onAudit = dependencies.onAudit;
		this.#config = dependencies.config ?? {};
	}

	enqueue(itemId: string, spec: WorkflowDownstreamSpec): WorkflowDownstreamJob {
		const timestamp = this.#now().toISOString();
		const job: WorkflowDownstreamJob = {
			id: this.#store.nextJobId(),
			itemId,
			kind: spec.kind,
			status: "QUEUED",
			retryEligible: spec.retryEligible ?? true,
			payload: structuredClone(spec.payload ?? {}),
			createdAt: timestamp,
			updatedAt: timestamp,
			attempts: [],
		};
		this.#store.saveJob(job);
		this.#emitAudit({
			id: this.#store.nextAuditId(),
			at: timestamp,
			kind: "downstream-queued",
			itemId,
			jobId: job.id,
			message: `Queued downstream job ${job.kind}`,
		});
		return job;
	}

	listJobs(filter: Parameters<WorkflowStore["listJobs"]>[0] = {}): WorkflowDownstreamJob[] {
		return this.#store.listJobs(filter);
	}

	startAvailable(): WorkflowDownstreamJob[] {
		const started: WorkflowDownstreamJob[] = [];
		const running = this.#store.listJobs({ status: "RUNNING" });
		const runningByKind = new Map<string, number>();
		for (const job of running) {
			runningByKind.set(job.kind, (runningByKind.get(job.kind) ?? 0) + 1);
		}
		const queued = this.#store.listJobs({ status: "QUEUED" });
		for (const job of queued) {
			if (this.#config.globalLimit !== undefined && running.length + started.length >= this.#config.globalLimit) {
				break;
			}
			const perKindLimit = this.#config.perKindLimit?.[job.kind];
			const currentRunning = runningByKind.get(job.kind) ?? 0;
			if (perKindLimit !== undefined && currentRunning >= perKindLimit) {
				continue;
			}
			const timestamp = this.#now().toISOString();
			const attempt: WorkflowDownstreamAttempt = {
				id: this.#store.nextAttemptId(),
				status: "RUNNING",
				startedAt: timestamp,
			};
			const updated: WorkflowDownstreamJob = {
				...job,
				status: "RUNNING",
				updatedAt: timestamp,
				attempts: [...job.attempts, attempt],
			};
			this.#store.saveJob(updated);
			runningByKind.set(job.kind, currentRunning + 1);
			started.push(updated);
			this.#emitAudit({
				id: this.#store.nextAuditId(),
				at: timestamp,
				kind: "downstream-started",
				itemId: job.itemId,
				jobId: job.id,
				message: `Started downstream job ${job.kind}`,
			});
		}
		return started;
	}

	markSucceeded(jobId: string, artifactPath?: string): WorkflowDownstreamJob {
		const job = this.#store.requireJob(jobId);
		const timestamp = this.#now().toISOString();
		const attempts: WorkflowDownstreamAttempt[] = job.attempts.map((attempt, index) =>
			index === job.attempts.length - 1
				? {
						...attempt,
						status: "SUCCEEDED",
						finishedAt: timestamp,
						...(artifactPath !== undefined ? { artifactPath } : {}),
					}
				: attempt,
		);
		const updated: WorkflowDownstreamJob = {
			...job,
			status: "SUCCEEDED",
			updatedAt: timestamp,
			attempts,
		};
		this.#store.saveJob(updated);
		this.#emitAudit({
			id: this.#store.nextAuditId(),
			at: timestamp,
			kind: "downstream-succeeded",
			itemId: job.itemId,
			jobId,
			message: `Succeeded downstream job ${job.kind}`,
		});
		return updated;
	}

	markFailed(jobId: string, error: string, retryEligible = false): WorkflowDownstreamJob {
		const job = this.#store.requireJob(jobId);
		const timestamp = this.#now().toISOString();
		const attempts: WorkflowDownstreamAttempt[] = job.attempts.map((attempt, index) =>
			index === job.attempts.length - 1
				? {
						...attempt,
						status: "FAILED",
						finishedAt: timestamp,
						error,
					}
				: attempt,
		);
		const updated: WorkflowDownstreamJob = {
			...job,
			status: "FAILED",
			retryEligible,
			updatedAt: timestamp,
			attempts,
		};
		this.#store.saveJob(updated);
		this.#emitAudit({
			id: this.#store.nextAuditId(),
			at: timestamp,
			kind: "downstream-failed",
			itemId: job.itemId,
			jobId,
			message: `Failed downstream job ${job.kind}`,
			data: { error },
		});
		return updated;
	}

	#emitAudit(entry: WorkflowAuditEntry): void {
		this.#store.appendAudit(entry);
		this.#onAudit?.(entry);
	}
}

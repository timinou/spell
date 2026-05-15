import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import type { SubagentOutcome } from "../task/types";

const DELIVERY_RETRY_BASE_MS = 500;
const DELIVERY_RETRY_MAX_MS = 30_000;
const DELIVERY_RETRY_JITTER_MS = 200;
const DEFAULT_RETENTION_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RUNNING_JOBS = 15;
const DEFAULT_JOB_TIMEOUT_MS = 25 * 60 * 1000;
const DEFAULT_WATCHDOG_GRACE_MS = 2_000;
const MAX_RETAINED_FINISHED_JOBS = 100;
const MAX_PENDING_DELIVERIES = 200;

export interface AsyncJobProgress {
	text: string;
	details?: Record<string, unknown>;
	updatedAt: number;
}

export interface AsyncJob {
	id: string;
	type: "bash" | "task";
	status: SubagentOutcome;
	startTime: number;
	label: string;
	abortController: AbortController;
	promise: Promise<void>;
	resultText?: string;
	errorText?: string;
	latestProgress?: AsyncJobProgress;
	endTime?: number;
	deliveryDropped?: boolean;
}

export interface AsyncJobManagerOptions {
	onJobComplete: (jobId: string, text: string, job?: AsyncJob) => void | Promise<void>;
	maxRunningJobs?: number;
	retentionMs?: number;
	/** Per-job liveness watchdog timeout in ms. 0 disables. Default: 25 * 60_000. */
	jobTimeoutMs?: number;
	/** Grace window after abort before forcing terminal status. Default: 2_000ms. */
	watchdogGraceMs?: number;
}

interface AsyncJobDelivery {
	jobId: string;
	text: string;
	attempt: number;
	nextAttemptAt: number;
	lastError?: string;
}

export interface AsyncJobDeliveryState {
	queued: number;
	delivering: boolean;
	nextRetryAt?: number;
	pendingJobIds: string[];
}

export interface AsyncJobRegisterOptions {
	id?: string;
	onProgress?: (text: string, details?: Record<string, unknown>) => void | Promise<void>;
	/** Override the manager's default job timeout. 0 disables. */
	timeoutMs?: number;
}

export class AsyncJobManager {
	readonly #jobs = new Map<string, AsyncJob>();
	readonly #deliveries: AsyncJobDelivery[] = [];
	readonly #suppressedDeliveries = new Set<string>();
	readonly #evictionTimers = new Map<string, NodeJS.Timeout>();
	readonly #onJobComplete: AsyncJobManagerOptions["onJobComplete"];
	readonly #maxRunningJobs: number;
	readonly #retentionMs: number;
	readonly #jobTimeoutMs: number;
	readonly #watchdogGraceMs: number;
	readonly #watchdogTimers = new Map<string, { timer: NodeJS.Timeout; timeoutMs: number; graceMs: number; inGrace?: boolean }>();
	readonly #watchdogRejects = new Map<string, (error: Error) => void>();
	#deliveryLoop: Promise<void> | undefined;
	#activeDelivery: AsyncJobDelivery | undefined;
	#disposed = false;

	constructor(options: AsyncJobManagerOptions) {
		this.#onJobComplete = options.onJobComplete;
		this.#maxRunningJobs = Math.max(1, Math.floor(options.maxRunningJobs ?? DEFAULT_MAX_RUNNING_JOBS));
		this.#retentionMs = Math.max(0, Math.floor(options.retentionMs ?? DEFAULT_RETENTION_MS));
		this.#jobTimeoutMs = Math.max(0, Math.floor(options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS));
		this.#watchdogGraceMs = Math.max(0, Math.floor(options.watchdogGraceMs ?? DEFAULT_WATCHDOG_GRACE_MS));
	}

	register(
		type: "bash" | "task",
		label: string,
		run: (ctx: {
			jobId: string;
			signal: AbortSignal;
			reportProgress: (text: string, details?: Record<string, unknown>) => Promise<void>;
		}) => Promise<string>,
		options?: AsyncJobRegisterOptions,
	): string {
		if (this.#disposed) {
			throw new Error("Async job manager is disposed");
		}
		const runningCount = this.getRunningJobs().length;
		if (runningCount >= this.#maxRunningJobs) {
			throw new Error(
				`Background job limit reached (${this.#maxRunningJobs}). Wait for running jobs to finish or cancel one.`,
			);
		}

		const id = this.#resolveJobId(options?.id);
		this.#suppressedDeliveries.delete(id);
		const abortController = new AbortController();
		const startTime = Date.now();

		const job: AsyncJob = {
			id,
			type,
			status: "running",
			startTime,
			label,
			abortController,
			promise: Promise.resolve(),
		};

		const reportProgress = async (text: string, details?: Record<string, unknown>): Promise<void> => {
			job.latestProgress = {
				text,
				...(details ? { details } : {}),
				updatedAt: Date.now(),
			};
			this.#rescheduleWatchdog(id);
			if (!options?.onProgress) return;
			try {
				await options.onProgress(text, details);
			} catch (error) {
				logger.warn("Async job progress callback failed", {
					jobId: id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		};

		let rejectWatchdog: (error: Error) => void;
		const runPromise = run({ jobId: id, signal: abortController.signal, reportProgress });
		runPromise.catch(() => {});
		const runRace = Promise.race([
			runPromise,
			new Promise<never>((_, reject) => {
				rejectWatchdog = reject;
			}),
		]);
		this.#watchdogRejects.set(id, rejectWatchdog!);

		job.promise = (async () => {
			try {
				const text = await runRace;
				this.#clearWatchdog(id);
				this.#watchdogRejects.delete(id);
				if (job.status === "failed") {
					this.#scheduleEviction(id);
					return;
				}
				if (job.status === "cancelled") {
					job.resultText = text;
					this.#scheduleEviction(id);
					return;
				}
				job.status = "completed";
				job.resultText = text;
				job.endTime = Date.now();
				this.#enqueueDelivery(id, text);
				this.#scheduleEviction(id);
			} catch (error) {
				this.#clearWatchdog(id);
				this.#watchdogRejects.delete(id);
				if (job.status === "failed") {
					this.#scheduleEviction(id);
					return;
				}
				if (job.status === "cancelled") {
					job.errorText = error instanceof Error ? error.message : String(error);
					this.#scheduleEviction(id);
					return;
				}
				const errorText = error instanceof Error ? error.message : String(error);
				job.status = "failed";
				job.errorText = errorText;
				job.endTime = Date.now();
				this.#enqueueDelivery(id, errorText);
				this.#scheduleEviction(id);
			}
		})();

		this.#jobs.set(id, job);
		const effectiveTimeoutMs = options?.timeoutMs ?? this.#jobTimeoutMs;
		if (effectiveTimeoutMs > 0) {
			this.#scheduleWatchdog(id, effectiveTimeoutMs, this.#watchdogGraceMs);
		}
		return id;
	}

	cancel(id: string): boolean {
		const job = this.#jobs.get(id);
		if (!job) return false;
		if (job.status !== "running") return false;
		job.status = "cancelled";
		job.endTime = Date.now();
		job.abortController.abort();
		this.#scheduleEviction(id);
		return true;
	}

	getJob(id: string): AsyncJob | undefined {
		return this.#jobs.get(id);
	}

	getRunningJobs(): AsyncJob[] {
		return Array.from(this.#jobs.values()).filter(job => job.status === "running");
	}

	getRecentJobs(limit = 10): AsyncJob[] {
		return Array.from(this.#jobs.values())
			.filter(job => job.status !== "running")
			.sort((a, b) => (b.endTime ?? b.startTime) - (a.endTime ?? a.startTime))
			.slice(0, limit);
	}

	getAllJobs(): AsyncJob[] {
		return Array.from(this.#jobs.values());
	}

	getDeliveryState(): AsyncJobDeliveryState {
		const nextRetryAt = this.#deliveries.reduce<number | undefined>((next, delivery) => {
			if (next === undefined) return delivery.nextAttemptAt;
			return Math.min(next, delivery.nextAttemptAt);
		}, undefined);

		return {
			queued: this.#deliveries.length,
			delivering: this.#deliveryLoop !== undefined,
			nextRetryAt,
			pendingJobIds: this.#deliveries.map(delivery => delivery.jobId),
		};
	}

	hasPendingDeliveries(): boolean {
		return this.#deliveries.length > 0;
	}

	acknowledgeDeliveries(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		if (uniqueJobIds.length === 0) return 0;

		for (const jobId of uniqueJobIds) {
			this.#suppressedDeliveries.add(jobId);
		}

		const before = this.#deliveries.length;
		this.#deliveries.splice(
			0,
			this.#deliveries.length,
			...this.#deliveries.filter(delivery => !this.#suppressedDeliveries.has(delivery.jobId)),
		);
		return before - this.#deliveries.length;
	}

	cancelAll(): void {
		for (const job of this.getRunningJobs()) {
			job.status = "cancelled";
			job.endTime = Date.now();
			job.abortController.abort();
			this.#scheduleEviction(job.id);
		}
		this.#clearAllWatchdogTimers();
	}

	async waitForAll(): Promise<void> {
		await Promise.all(Array.from(this.#jobs.values()).map(job => job.promise));
	}

	async drainDeliveries(options?: { timeoutMs?: number }): Promise<boolean> {
		const timeoutMs = options?.timeoutMs;
		const hasDeadline = timeoutMs !== undefined;
		const deadline = hasDeadline ? Date.now() + Math.max(timeoutMs, 0) : Number.POSITIVE_INFINITY;

		while (this.hasPendingDeliveries()) {
			this.#ensureDeliveryLoop();
			const loop = this.#deliveryLoop;
			if (!loop) {
				continue;
			}

			if (!hasDeadline) {
				await loop;
				continue;
			}

			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				return false;
			}

			await Promise.race([loop, Bun.sleep(remainingMs)]);
			if (Date.now() >= deadline && this.hasPendingDeliveries()) {
				return false;
			}
		}

		return true;
	}

	async dispose(options?: { timeoutMs?: number }): Promise<boolean> {
		this.#disposed = true;
		this.#clearEvictionTimers();
		this.#clearAllWatchdogTimers();
		this.cancelAll();
		await this.waitForAll();
		const drained = await this.drainDeliveries({ timeoutMs: options?.timeoutMs ?? 3_000 });
		this.#clearEvictionTimers();
		this.#jobs.clear();
		this.#deliveries.length = 0;
		this.#suppressedDeliveries.clear();
		return drained;
	}

	#resolveJobId(preferredId?: string): string {
		if (!preferredId || preferredId.trim().length === 0) {
			return `bg_${Snowflake.next()}`;
		}

		const base = preferredId.trim();
		if (!this.#jobs.has(base)) return base;

		let suffix = 2;
		let candidate = `${base}-${suffix}`;
		while (this.#jobs.has(candidate)) {
			suffix += 1;
			candidate = `${base}-${suffix}`;
		}
		return candidate;
	}

	#cleanupJobArtifacts(jobId: string): void {
		const timer = this.#evictionTimers.get(jobId);
		if (timer) {
			clearTimeout(timer);
			this.#evictionTimers.delete(jobId);
		}
		const watchdogEntry = this.#watchdogTimers.get(jobId);
		if (watchdogEntry) {
			clearTimeout(watchdogEntry.timer);
			this.#watchdogTimers.delete(jobId);
		}
		this.#watchdogRejects.delete(jobId);
		this.#suppressedDeliveries.delete(jobId);
		this.#deliveries.splice(
			0,
			this.#deliveries.length,
			...this.#deliveries.filter(delivery => delivery.jobId !== jobId),
		);
	}

	#pruneCompletedJobs(): void {
		const finishedJobs = Array.from(this.#jobs.values())
			.filter(job => job.status !== "running")
			.sort((a, b) => (a.endTime ?? a.startTime) - (b.endTime ?? b.startTime));
		const excessJobs = finishedJobs.length - MAX_RETAINED_FINISHED_JOBS;
		if (excessJobs <= 0) return;

		for (const job of finishedJobs.slice(0, excessJobs)) {
			this.#cleanupJobArtifacts(job.id);
			this.#jobs.delete(job.id);
		}
	}

	#scheduleEviction(jobId: string): void {
		if (this.#retentionMs <= 0) {
			this.#cleanupJobArtifacts(jobId);
			this.#jobs.delete(jobId);
			this.#pruneCompletedJobs();
			return;
		}

		const existing = this.#evictionTimers.get(jobId);
		if (existing) {
			clearTimeout(existing);
		}

		const timer = setTimeout(() => {
			this.#evictionTimers.delete(jobId);
			this.#cleanupJobArtifacts(jobId);
			this.#jobs.delete(jobId);
			this.#pruneCompletedJobs();
		}, this.#retentionMs);
		timer.unref();
		this.#evictionTimers.set(jobId, timer);
		this.#pruneCompletedJobs();
	}

	#clearEvictionTimers(): void {
		for (const timer of this.#evictionTimers.values()) {
			clearTimeout(timer);
		}
		this.#evictionTimers.clear();
	}

	#scheduleWatchdog(jobId: string, timeoutMs: number, graceMs: number): void {
		const existing = this.#watchdogTimers.get(jobId);
		if (existing) {
			clearTimeout(existing.timer);
		}
		const timer = setTimeout(() => this.#fireWatchdog(jobId), timeoutMs);
		timer.unref?.();
		this.#watchdogTimers.set(jobId, { timer, timeoutMs, graceMs });
	}

	#rescheduleWatchdog(jobId: string): void {
		const entry = this.#watchdogTimers.get(jobId);
		if (!entry || entry.inGrace) return;
		clearTimeout(entry.timer);
		const timer = setTimeout(() => this.#fireWatchdog(jobId), entry.timeoutMs);
		timer.unref?.();
		entry.timer = timer;
	}

	#clearWatchdog(jobId: string): void {
		const entry = this.#watchdogTimers.get(jobId);
		if (entry) {
			clearTimeout(entry.timer);
			this.#watchdogTimers.delete(jobId);
		}
	}

	#fireWatchdog(jobId: string): void {
		const job = this.#jobs.get(jobId);
		if (!job || job.status !== "running") {
			this.#watchdogTimers.delete(jobId);
			return;
		}
		const entry = this.#watchdogTimers.get(jobId);
		const timeoutMs = entry?.timeoutMs ?? this.#jobTimeoutMs;
		const graceMs = entry?.graceMs ?? this.#watchdogGraceMs;
		if (entry) {
			clearTimeout(entry.timer);
			entry.inGrace = true;
		}
		job.abortController.abort();
		const graceTimer = setTimeout(() => {
			this.#watchdogTimers.delete(jobId);
			this.#watchdogRejects.get(jobId)?.(
				new Error(`Job exceeded ${Math.round(timeoutMs / 1000)}s watchdog timeout`),
			);
			this.#watchdogRejects.delete(jobId);
			const j = this.#jobs.get(jobId);
			if (!j || j.status !== "running") return;
			j.status = "failed";
			j.errorText = `Job exceeded ${Math.round(timeoutMs / 1000)}s watchdog timeout`;
			j.endTime = Date.now();
			this.#enqueueDelivery(jobId, j.errorText);
			this.#scheduleEviction(jobId);
		}, graceMs);
		graceTimer.unref?.();
		if (entry) {
			entry.timer = graceTimer;
		}
	}

	#clearAllWatchdogTimers(): void {
		for (const entry of this.#watchdogTimers.values()) {
			clearTimeout(entry.timer);
		}
		this.#watchdogTimers.clear();
		this.#watchdogRejects.clear();
	}

	#dropOldestDeliveries(reason: "queue_cap" | "retry_queue_cap", incomingJobId: string): void {
		let excessDeliveries = this.#deliveries.length - MAX_PENDING_DELIVERIES;
		if (excessDeliveries <= 0) {
			return;
		}

		const droppedDeliveries: AsyncJobDelivery[] = [];
		let index = 0;
		while (excessDeliveries > 0 && index < this.#deliveries.length) {
			const delivery = this.#deliveries[index];
			if (delivery === this.#activeDelivery) {
				index += 1;
				continue;
			}
			droppedDeliveries.push(delivery);
			this.#deliveries.splice(index, 1);
			excessDeliveries -= 1;
		}

		for (const droppedDelivery of droppedDeliveries) {
			const job = this.#jobs.get(droppedDelivery.jobId);
			if (job) {
				job.deliveryDropped = true;
			}
			logger.warn("Async job completion delivery dropped due to queue cap", {
				reason,
				droppedJobId: droppedDelivery.jobId,
				incomingJobId,
				queued: this.#deliveries.length,
				maxPendingDeliveries: MAX_PENDING_DELIVERIES,
			});
		}
	}

	#isDeliverySuppressed(jobId: string): boolean {
		return this.#suppressedDeliveries.has(jobId);
	}

	#enqueueDelivery(jobId: string, text: string): void {
		if (this.#isDeliverySuppressed(jobId)) {
			return;
		}
		this.#deliveries.push({
			jobId,
			text,
			attempt: 0,
			nextAttemptAt: Date.now(),
		});
		this.#dropOldestDeliveries("queue_cap", jobId);
		this.#ensureDeliveryLoop();
	}

	#ensureDeliveryLoop(): void {
		if (this.#deliveryLoop) {
			return;
		}

		this.#deliveryLoop = this.#runDeliveryLoop()
			.catch(error => {
				logger.error("Async job delivery loop crashed", { error: String(error) });
			})
			.finally(() => {
				this.#deliveryLoop = undefined;
				if (this.#deliveries.length > 0) {
					this.#ensureDeliveryLoop();
				}
			});
	}

	async #runDeliveryLoop(): Promise<void> {
		while (this.#deliveries.length > 0) {
			const delivery = this.#deliveries[0];
			if (this.#isDeliverySuppressed(delivery.jobId)) {
				this.#deliveries.shift();
				continue;
			}
			const waitMs = delivery.nextAttemptAt - Date.now();
			if (waitMs > 0) {
				await Bun.sleep(waitMs);
			}
			if (this.#deliveries[0] !== delivery) {
				continue;
			}
			if (this.#isDeliverySuppressed(delivery.jobId)) {
				this.#deliveries.shift();
				continue;
			}

			this.#activeDelivery = delivery;
			try {
				await this.#onJobComplete(delivery.jobId, delivery.text, this.#jobs.get(delivery.jobId));
				if (this.#deliveries[0] === delivery) {
					this.#deliveries.shift();
				}
			} catch (error) {
				delivery.attempt += 1;
				delivery.lastError = error instanceof Error ? error.message : String(error);
				delivery.nextAttemptAt = Date.now() + this.#getRetryDelay(delivery.attempt);
				if (this.#deliveries[0] === delivery) {
					this.#deliveries.shift();
				}
				if (!this.#isDeliverySuppressed(delivery.jobId)) {
					this.#deliveries.push(delivery);
					this.#dropOldestDeliveries("retry_queue_cap", delivery.jobId);
				}
				logger.warn("Async job completion delivery failed", {
					jobId: delivery.jobId,
					attempt: delivery.attempt,
					nextRetryAt: delivery.nextAttemptAt,
					error: delivery.lastError,
				});
			} finally {
				if (this.#activeDelivery === delivery) {
					this.#activeDelivery = undefined;
				}
			}
		}
	}

	#getRetryDelay(attempt: number): number {
		const exp = Math.min(Math.max(attempt - 1, 0), 8);
		const backoffMs = DELIVERY_RETRY_BASE_MS * 2 ** exp;
		const jitterMs = Math.floor(Math.random() * DELIVERY_RETRY_JITTER_MS);
		return Math.min(DELIVERY_RETRY_MAX_MS, backoffMs + jitterMs);
	}
}

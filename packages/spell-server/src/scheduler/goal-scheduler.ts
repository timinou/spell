import { logger } from "@oh-my-pi/pi-utils";
import { Cron } from "croner";
import type { GoalScheduleEntry, ScheduledGoalInfo } from "./types";

type ScheduledJob = {
	cron: Cron;
	entry: GoalScheduleEntry;
	running: boolean;
	pendingJitter?: NodeJS.Timeout;
};

export class GoalScheduler {
	#jobs = new Map<string, ScheduledJob>();
	#started = false;

	register(entry: GoalScheduleEntry): void {
		this.unregister(entry.goalName);
		const cron = new Cron(
			entry.cronExpression,
			{
				timezone: entry.timezone,
				paused: !this.#started,
			},
			() => {
				this.#onTick(entry.goalName);
			},
		);
		this.#jobs.set(entry.goalName, { cron, entry, running: false });
	}

	unregister(goalName: string): void {
		const job = this.#jobs.get(goalName);
		if (!job) {
			return;
		}
		job.cron.stop();
		if (job.pendingJitter) {
			clearTimeout(job.pendingJitter);
		}
		this.#jobs.delete(goalName);
	}

	start(): void {
		this.#started = true;
		for (const job of this.#jobs.values()) {
			job.cron.resume();
		}
	}

	stop(): void {
		this.#started = false;
		for (const job of this.#jobs.values()) {
			job.cron.pause();
			if (job.pendingJitter) {
				clearTimeout(job.pendingJitter);
				job.pendingJitter = undefined;
			}
		}
	}

	getNextFireTime(goalName: string): Date | null {
		return this.#jobs.get(goalName)?.cron.nextRun() ?? null;
	}

	getScheduledGoals(): ScheduledGoalInfo[] {
		return [...this.#jobs.entries()].map(([goalName, job]) => ({
			goalName,
			cronExpression: job.entry.cronExpression,
			timezone: job.entry.timezone,
			jitterMs: job.entry.jitterMs,
			nextFireTime: job.cron.nextRun() ?? null,
			running: job.running,
		}));
	}

	markRunComplete(goalName: string): void {
		const job = this.#jobs.get(goalName);
		if (job) {
			job.running = false;
		}
	}

	#onTick(goalName: string): void {
		const job = this.#jobs.get(goalName);
		if (!job) {
			return;
		}
		if (job.running || job.pendingJitter) {
			logger.warn("Skipping cron tick: goal already running", { goalName });
			return;
		}
		if (job.entry.jitterMs > 0) {
			const delay = Math.floor(Math.random() * job.entry.jitterMs);
			job.pendingJitter = setTimeout(() => {
				job.pendingJitter = undefined;
				this.#fireCallback(goalName, job);
			}, delay);
			return;
		}
		this.#fireCallback(goalName, job);
	}

	#fireCallback(goalName: string, job: ScheduledJob): void {
		job.running = true;
		try {
			const result = job.entry.callback();
			if (result instanceof Promise) {
				result
					.catch(error => {
						logger.error("Goal callback failed", { goalName, error: String(error) });
					})
					.finally(() => {
						job.running = false;
					});
				return;
			}
		} catch (error) {
			logger.error("Goal callback threw", { goalName, error: String(error) });
		}
		job.running = false;
	}
}

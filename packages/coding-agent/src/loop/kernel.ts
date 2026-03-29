import {
	DEFAULT_BUDGET_LIMITS,
	DEFAULT_LOOP_MAX_ITERATIONS,
	DEFAULT_LOOP_REFLECT_EVERY,
	LOOP_SCHEMA_VERSION,
} from "./constants";
import type { LoopEvent, LoopState } from "./contracts";
import { LOOP_STATES } from "./contracts";
import { hashTaskContent } from "./hash";
import { createLoopId } from "./ids";
import { LoopRegistry } from "./loop-registry";
import type { LoopListEntry, LoopSnapshot, StartLoopOptions } from "./types";

interface LoopKernelOptions {
	concurrencyLimit?: number;
	now?: () => number;
	onEvent?: (event: LoopEvent, snapshot: LoopSnapshot) => void;
}

interface LoopDoneOptions {
	summary?: string;
	changedFiles?: string[];
	findings?: string[];
	forceValidate?: boolean;
	taskContent?: string;
}

const ALLOWED_TRANSITIONS: Record<LoopState, readonly LoopState[]> = {
	idle: [LOOP_STATES.planning],
	planning: [LOOP_STATES.iterating, LOOP_STATES.paused, LOOP_STATES.failed, LOOP_STATES.killed, LOOP_STATES.cancelled],
	iterating: [
		LOOP_STATES.planning,
		LOOP_STATES.reflecting,
		LOOP_STATES.validating,
		LOOP_STATES.paused,
		LOOP_STATES.failed,
		LOOP_STATES.killed,
		LOOP_STATES.cancelled,
	],
	reflecting: [
		LOOP_STATES.planning,
		LOOP_STATES.validating,
		LOOP_STATES.paused,
		LOOP_STATES.failed,
		LOOP_STATES.killed,
		LOOP_STATES.cancelled,
	],
	validating: [
		LOOP_STATES.complete,
		LOOP_STATES.failed,
		LOOP_STATES.paused,
		LOOP_STATES.killed,
		LOOP_STATES.cancelled,
	],
	complete: [],
	failed: [],
	paused: [LOOP_STATES.iterating, LOOP_STATES.planning, LOOP_STATES.killed, LOOP_STATES.cancelled],
	cancelled: [],
	killed: [],
};

function cloneLoop(loop: LoopSnapshot): LoopSnapshot {
	return structuredClone(loop);
}

export class LoopKernel {
	readonly #registry: LoopRegistry;
	readonly #now: () => number;
	readonly #onEvent?: (event: LoopEvent, snapshot: LoopSnapshot) => void;

	constructor(options: LoopKernelOptions = {}) {
		this.#registry = new LoopRegistry(options.concurrencyLimit);
		this.#now = options.now ?? Date.now;
		this.#onEvent = options.onEvent;
	}

	start(config: StartLoopOptions): LoopSnapshot {
		this.#registry.assertCanStart();
		const now = this.#now();
		const id = config.id ?? createLoopId(config.name, now);
		const taskContent = config.taskContent?.trim();
		const loop: LoopSnapshot = {
			id,
			name: config.name,
			state: LOOP_STATES.planning,
			iteration: 0,
			maxIterations: config.maxIterations ?? DEFAULT_LOOP_MAX_ITERATIONS,
			depth: config.depth ?? 0,
			parentLoopId: config.parentLoopId,
			orgItemId: id,
			createdAt: now,
			updatedAt: now,
			startedAt: now,
			currentRole: "plan",
			reflectEvery: config.reflectEvery ?? DEFAULT_LOOP_REFLECT_EVERY,
			taskFilePath: config.taskFilePath,
			taskFileHash: hashTaskContent(taskContent),
			taskContent,
			changedFiles: [],
			openFindings: [],
			childLoopIds: [],
			requiredChildLoopIds: [],
			pendingChildLoopIds: [],
			pendingGates: [],
			gateConfigs: config.gates ?? [],
			gateResults: [],
			checkpoints: [],
			handoffs: [],
			budgetLimits: {
				wallClockMs: config.budgetLimits?.wallClockMs ?? DEFAULT_BUDGET_LIMITS.wallClockMs,
				maxTreeIterations: config.budgetLimits?.maxTreeIterations ?? DEFAULT_BUDGET_LIMITS.maxTreeIterations,
				maxIdleIterations: config.budgetLimits?.maxIdleIterations ?? DEFAULT_BUDGET_LIMITS.maxIdleIterations,
			},
			budgetStatus: { elapsedMs: 0, treeIterations: 0, idleIterations: 0 },
			totalTreeIterations: 0,
			specPaths: config.specPaths ?? [],
			domainNames: config.domains ?? [],
			lastProgressHash: hashTaskContent(taskContent),
			autoApproveEnabled: config.autoApproveEnabled ?? true,
			reviewModelConfigured: false,
			gitAvailable: true,
		};
		this.#registry.add(loop);
		this.#emit(loop, "loop.created", { state: loop.state, iteration: 0, name: loop.name });
		return cloneLoop(loop);
	}

	pause(loopId: string, reason?: string): LoopSnapshot {
		return this.#transition(loopId, LOOP_STATES.paused, { reason });
	}

	resume(loopId: string): LoopSnapshot {
		return this.#transition(loopId, LOOP_STATES.iterating, {});
	}

	kill(loopId: string, reason = "Killed by operator"): LoopSnapshot {
		const loop = this.#transition(loopId, LOOP_STATES.killed, { reason });
		loop.completedAt = this.#now();
		this.#registry.update(loop);
		this.#emit(loop, "loop.killed", { reason });
		return cloneLoop(loop);
	}

	fail(loopId: string, reason: string): LoopSnapshot {
		return this.#transition(loopId, LOOP_STATES.failed, { reason });
	}

	setOrgItemId(loopId: string, orgItemId: string): LoopSnapshot {
		return this.updateLoop(
			loopId,
			loop => {
				loop.orgItemId = orgItemId;
			},
			"loop.org_synced",
			{ orgItemId },
		);
	}

	setReviewModelConfigured(loopId: string, configured: boolean): LoopSnapshot {
		return this.updateLoop(
			loopId,
			loop => {
				loop.reviewModelConfigured = configured;
			},
			"loop.review_model",
			{ configured },
		);
	}

	done(loopId: string, options: LoopDoneOptions = {}): LoopSnapshot {
		const loop = this.#registry.get(loopId);
		if (
			loop.state === LOOP_STATES.complete ||
			loop.state === LOOP_STATES.failed ||
			loop.state === LOOP_STATES.killed
		) {
			throw new Error(`Cannot advance loop from terminal state ${loop.state}`);
		}
		if (loop.state === LOOP_STATES.paused) {
			return this.resume(loopId);
		}
		if (loop.state === LOOP_STATES.planning) {
			return this.#transition(loopId, LOOP_STATES.iterating, { resumedFromPlanning: true });
		}
		if (loop.state === LOOP_STATES.reflecting) {
			return this.#transition(loopId, LOOP_STATES.planning, { reflectionComplete: true });
		}
		if (loop.state === LOOP_STATES.validating) {
			const complete = this.#transition(loopId, LOOP_STATES.complete, { validationComplete: true });
			complete.completedAt = this.#now();
			this.#registry.update(complete);
			this.#emit(complete, "loop.completed", { iteration: complete.iteration });
			return cloneLoop(complete);
		}
		if (loop.state !== LOOP_STATES.iterating) {
			throw new Error(`Cannot advance loop from state ${loop.state}`);
		}

		loop.iteration += 1;
		loop.totalTreeIterations += 1;
		loop.budgetStatus.treeIterations += 1;
		loop.budgetStatus.elapsedMs = Math.max(0, this.#now() - loop.startedAt);
		loop.changedFiles = [...(options.changedFiles ?? [])];
		loop.openFindings = [...(options.findings ?? [])];
		loop.lastSummary = options.summary;
		if (options.taskContent !== undefined) {
			loop.taskContent = options.taskContent;
			loop.taskFileHash = hashTaskContent(options.taskContent);
		}
		loop.lastProgressHash = hashTaskContent(
			JSON.stringify({ task: loop.taskContent ?? "", files: loop.changedFiles, summary: loop.lastSummary ?? "" }),
		);
		loop.updatedAt = this.#now();
		this.#registry.update(loop);
		this.#emit(loop, "loop.iteration_completed", {
			iteration: loop.iteration,
			summary: options.summary,
			changedFiles: loop.changedFiles,
			findings: loop.openFindings,
		});

		if (options.forceValidate || loop.iteration >= loop.maxIterations) {
			return this.#transition(loopId, LOOP_STATES.validating, {
				maxIterationsReached: loop.iteration >= loop.maxIterations,
			});
		}
		if (loop.reflectEvery > 0 && loop.iteration % loop.reflectEvery === 0) {
			return this.#transition(loopId, LOOP_STATES.reflecting, { reflectEvery: loop.reflectEvery });
		}
		return this.#transition(loopId, LOOP_STATES.planning, { nextIteration: loop.iteration + 1 });
	}

	updateLoop(
		loopId: string,
		updater: (loop: LoopSnapshot) => void,
		eventType = "loop.updated",
		payload: Record<string, unknown> = {},
	): LoopSnapshot {
		const loop = this.#registry.get(loopId);
		updater(loop);
		loop.updatedAt = this.#now();
		loop.budgetStatus.elapsedMs = Math.max(0, this.#now() - loop.startedAt);
		this.#registry.update(loop);
		this.#emit(loop, eventType, payload);
		return cloneLoop(loop);
	}

	getState(loopId: string): LoopSnapshot {
		return cloneLoop(this.#registry.get(loopId));
	}

	listLoops(): LoopListEntry[] {
		return this.#registry.listEntries();
	}

	restore(snapshot: LoopSnapshot): LoopSnapshot {
		this.#registry.add(structuredClone(snapshot));
		return this.getState(snapshot.id);
	}

	#transition(loopId: string, nextState: LoopState, payload: Record<string, unknown>): LoopSnapshot {
		const loop = this.#registry.get(loopId);
		if (!ALLOWED_TRANSITIONS[loop.state].includes(nextState)) {
			throw new Error(`Invalid loop transition: ${loop.state} -> ${nextState}`);
		}
		const previousState = loop.state;
		loop.state = nextState;
		loop.updatedAt = this.#now();
		loop.budgetStatus.elapsedMs = Math.max(0, this.#now() - loop.startedAt);
		if (nextState === LOOP_STATES.paused) {
			loop.pausedAt = this.#now();
			loop.statusReason = typeof payload.reason === "string" ? payload.reason : undefined;
		} else if (previousState === LOOP_STATES.paused) {
			loop.pausedAt = undefined;
		}
		this.#registry.update(loop);
		this.#emit(loop, "loop.state_changed", { from: previousState, to: nextState, ...payload });
		return loop;
	}

	#emit(snapshot: LoopSnapshot, type: string, payload: Record<string, unknown>): void {
		this.#onEvent?.(
			{
				version: LOOP_SCHEMA_VERSION,
				type,
				loopId: snapshot.id,
				parentLoopId: snapshot.parentLoopId,
				timestamp: this.#now(),
				payload,
			},
			cloneLoop(snapshot),
		);
	}
}

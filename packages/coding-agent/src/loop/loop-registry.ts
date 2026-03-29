import { DEFAULT_LOOP_CONCURRENCY_LIMIT } from "./constants";
import type { LoopListEntry, LoopSnapshot } from "./types";

const ACTIVE_STATES = new Set(["planning", "iterating", "reflecting", "validating"]);

function cloneLoop(loop: LoopSnapshot): LoopSnapshot {
	return structuredClone(loop);
}

export class LoopRegistry {
	#loops = new Map<string, LoopSnapshot>();
	#concurrencyLimit: number;

	constructor(concurrencyLimit = DEFAULT_LOOP_CONCURRENCY_LIMIT) {
		this.#concurrencyLimit = concurrencyLimit;
	}

	setConcurrencyLimit(limit: number): void {
		this.#concurrencyLimit = limit;
	}

	assertCanStart(): void {
		if (this.#concurrencyLimit <= 0) return;
		const active = this.listActive().length;
		if (active >= this.#concurrencyLimit) {
			throw new Error(`Loop concurrency limit reached (${this.#concurrencyLimit})`);
		}
	}

	add(loop: LoopSnapshot): void {
		if (this.#loops.has(loop.id)) {
			throw new Error(`Loop already exists: ${loop.id}`);
		}
		this.#loops.set(loop.id, loop);
	}

	update(loop: LoopSnapshot): void {
		if (!this.#loops.has(loop.id)) {
			throw new Error(`Unknown loop: ${loop.id}`);
		}
		this.#loops.set(loop.id, loop);
	}

	get(loopId: string): LoopSnapshot {
		const loop = this.#loops.get(loopId);
		if (!loop) {
			throw new Error(`Unknown loop: ${loopId}`);
		}
		return loop;
	}

	getOptional(loopId: string): LoopSnapshot | undefined {
		return this.#loops.get(loopId);
	}

	list(): LoopSnapshot[] {
		return Array.from(this.#loops.values(), cloneLoop);
	}

	listActive(): LoopSnapshot[] {
		return this.list().filter(loop => ACTIVE_STATES.has(loop.state));
	}

	listEntries(): LoopListEntry[] {
		return this.list().map(loop => ({
			id: loop.id,
			name: loop.name,
			state: loop.state,
			iteration: loop.iteration,
			maxIterations: loop.maxIterations,
			depth: loop.depth,
			parentLoopId: loop.parentLoopId,
			budget: structuredClone(loop.budgetStatus),
			pendingHumanGates: loop.pendingGates.length,
			gitAvailable: loop.gitAvailable,
		}));
	}
}

/**
 * SpinnerClock — singleton 80ms ticker that drives all uniform spinners.
 * One setInterval regardless of how many spinners are active; auto-starts on
 * first subscriber, auto-stops when subscriber set is empty.
 *
 * Visually distinct animations (voice, caveman) keep their own clocks.
 */

const TICK_MS = 80;

class SpinnerClock {
	#subscribers = new Set<() => void>();
	#interval?: NodeJS.Timeout;
	#frame = 0;

	subscribe(cb: () => void): () => void {
		this.#subscribers.add(cb);
		if (!this.#interval) {
			this.#interval = setInterval(() => this.#tick(), TICK_MS);
			this.#interval.unref?.();
		}
		return () => {
			this.#subscribers.delete(cb);
			if (this.#subscribers.size === 0 && this.#interval) {
				clearInterval(this.#interval);
				this.#interval = undefined;
			}
		};
	}

	/** Current frame tick (monotonically increasing). Consumers should modulo by their frame array length. */
	get frame(): number {
		return this.#frame;
	}

	/** Snapshot frame count — useful for tests; monotonically increasing. */
	get tickCount(): number {
		return this.#frame;
	}

	/** Test-only: reset state. */
	resetForTest(): void {
		if (this.#interval) {
			clearInterval(this.#interval);
			this.#interval = undefined;
		}
		this.#subscribers.clear();
		this.#frame = 0;
	}

	#tick(): void {
		this.#frame++;
		// Iterate a snapshot — a subscriber's callback may unsubscribe itself
		const snapshot = [...this.#subscribers];
		for (const cb of snapshot) {
			try {
				cb();
			} catch {
				/* swallow — one sink failing shouldn't break others */
			}
		}
	}
}

export const spinnerClock = new SpinnerClock();

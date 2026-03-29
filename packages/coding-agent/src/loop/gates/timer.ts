import type { Clock, ClockHandle } from "./clock";

export class GateTimer {
	readonly #clock: Clock;
	readonly #onFire: () => void;
	#delayMs: number;
	#handle?: ClockHandle;
	#deadline?: number;

	constructor(clock: Clock, delayMs: number, onFire: () => void) {
		this.#clock = clock;
		this.#delayMs = delayMs;
		this.#onFire = onFire;
	}

	start(): void {
		this.cancel();
		this.#deadline = this.#clock.now() + this.#delayMs;
		this.#handle = this.#clock.setTimeout(() => {
			this.#handle = undefined;
			this.#deadline = undefined;
			this.#onFire();
		}, this.#delayMs);
	}

	cancel(): void {
		if (!this.#handle) return;
		this.#clock.clearTimeout(this.#handle);
		this.#handle = undefined;
		this.#deadline = undefined;
	}

	reset(delayMs = this.#delayMs): void {
		this.#delayMs = delayMs;
		this.start();
	}

	getRemainingMs(): number {
		if (this.#deadline === undefined) return 0;
		return Math.max(0, this.#deadline - this.#clock.now());
	}
}

export interface PullPollerOptions {
	/** Interval in ms */
	intervalMs: number;
	/** Callback to execute pull */
	onPull: () => Promise<void>;
	/** Error callback */
	onError?: (error: Error) => void;
}

export class PullPoller {
	#timer: Timer | null = null;
	#options: PullPollerOptions;
	#running = false;

	constructor(options: PullPollerOptions) {
		this.#options = options;
	}

	start(): void {
		if (this.#timer) return;
		this.#timer = setInterval(() => void this.#tick(), this.#options.intervalMs);
	}

	stop(): void {
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = null;
		}
	}

	async #tick(): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		try {
			await this.#options.onPull();
		} catch (error) {
			this.#options.onError?.(error instanceof Error ? error : new Error(String(error)));
		} finally {
			this.#running = false;
		}
	}
}

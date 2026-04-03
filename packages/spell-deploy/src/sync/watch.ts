import { PullPoller } from "./poller";
import { executePull } from "./pull";
import { executePush } from "./push";
import type { SyncEvent, WatchOptions, WatchState } from "./watch-types";
import { FileWatcher } from "./watcher";

/** Parse duration string like "2s" or "30s" to milliseconds */
export function parseDuration(duration: string): number {
	const match = /^(\d+)(ms|s|m|h)$/.exec(duration);
	if (!match) {
		throw new Error(`Invalid duration: ${duration}`);
	}

	const value = Number(match[1]);
	const unit = match[2];
	switch (unit) {
		case "ms":
			return value;
		case "s":
			return value * 1000;
		case "m":
			return value * 60_000;
		case "h":
			return value * 3_600_000;
		default:
			throw new Error(`Unknown unit: ${unit}`);
	}
}

/** Bidirectional watch orchestrator */
export class WatchOrchestrator {
	#watcher: FileWatcher;
	#poller: PullPoller;
	#options: WatchOptions;
	#state: WatchState = { running: false, pushCount: 0, pullCount: 0 };
	#syncLock = false;

	constructor(options: WatchOptions) {
		this.#options = options;
		const debounceMs = parseDuration(options.sync.pushDebounce);
		const pullIntervalMs = parseDuration(options.sync.pullInterval);

		this.#watcher = new FileWatcher({
			root: options.localRoot,
			exclude: options.target.exclude,
			debounceMs,
			onChange: files => void this.#handlePush(files),
		});

		this.#poller = new PullPoller({
			intervalMs: pullIntervalMs,
			onPull: () => this.#handlePull(),
			onError: error => options.onError?.(error),
		});
	}

	get state(): WatchState {
		return { ...this.#state };
	}

	start(): void {
		this.#state.running = true;
		this.#watcher.start();
		this.#poller.start();
	}

	stop(): void {
		this.#state.running = false;
		this.#watcher.stop();
		this.#poller.stop();
	}

	async #handlePush(files: string[]): Promise<void> {
		if (this.#syncLock) return;
		this.#syncLock = true;
		try {
			await executePush({
				target: this.#options.target,
				localRoot: this.#options.localRoot,
				dryRun: false,
			});
			const event: SyncEvent = { type: "push", timestamp: Date.now(), files };
			this.#state.lastPush = event;
			this.#state.pushCount++;
			this.#options.onSync?.(event);
		} catch (error) {
			this.#options.onError?.(error instanceof Error ? error : new Error(String(error)));
		} finally {
			this.#syncLock = false;
		}
	}

	async #handlePull(): Promise<void> {
		if (this.#syncLock) return;
		this.#syncLock = true;
		try {
			await executePull({
				target: this.#options.target,
				sync: this.#options.sync,
				localRoot: this.#options.localRoot,
				dryRun: false,
			});
			const event: SyncEvent = { type: "pull", timestamp: Date.now() };
			this.#state.lastPull = event;
			this.#state.pullCount++;
			this.#options.onSync?.(event);
		} catch (error) {
			this.#options.onError?.(error instanceof Error ? error : new Error(String(error)));
		} finally {
			this.#syncLock = false;
		}
	}
}

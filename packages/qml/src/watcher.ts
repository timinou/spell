import * as fs from "node:fs";
import { logger } from "@oh-my-pi/pi-utils";

/**
 * Watches QML files for changes and calls a callback on modification.
 * Uses native fs.watch; debounces by 150ms to avoid double-firing.
 */
export class QmlWatcher {
	readonly #watchers = new Map<string, fs.FSWatcher>();
	readonly #timers = new Map<string, NodeJS.Timeout>();

	watch(id: string, filePath: string, onChange: () => void): void {
		this.unwatch(id);
		try {
			const watcher = fs.watch(filePath, () => {
				// Debounce
				const existing = this.#timers.get(id);
				if (existing) clearTimeout(existing);
				const timer = setTimeout(() => {
					this.#timers.delete(id);
					onChange();
				}, 150);
				this.#timers.set(id, timer);
			});
			this.#watchers.set(id, watcher);
		} catch (err) {
			logger.warn("QmlWatcher: failed to watch file", { id, filePath, error: String(err) });
		}
	}

	unwatch(id: string): void {
		this.#watchers.get(id)?.close();
		this.#watchers.delete(id);
		const timer = this.#timers.get(id);
		if (timer) {
			clearTimeout(timer);
			this.#timers.delete(id);
		}
	}

	dispose(): void {
		for (const id of [...this.#watchers.keys()]) {
			this.unwatch(id);
		}
	}
}

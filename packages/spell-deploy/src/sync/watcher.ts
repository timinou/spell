import * as fs from "node:fs";

export interface FileWatcherOptions {
	/** Root directory to watch */
	root: string;
	/** Patterns to exclude (e.g. node_modules, .git) */
	exclude: string[];
	/** Debounce interval in ms */
	debounceMs: number;
	/** Callback when changes detected after debounce */
	onChange: (changedPaths: string[]) => void;
}

export function shouldExclude(filePath: string, patterns: string[]): boolean {
	return patterns.some(pattern => {
		const normalized = pattern.replace(/\/$/, "");
		return filePath.startsWith(`${normalized}/`) || filePath === normalized || filePath.startsWith(normalized);
	});
}

export class FileWatcher {
	#watcher: fs.FSWatcher | null = null;
	#debounceTimer: Timer | null = null;
	#pendingChanges = new Set<string>();
	#options: FileWatcherOptions;

	constructor(options: FileWatcherOptions) {
		this.#options = options;
	}

	start(): void {
		if (this.#watcher) return;
		this.#watcher = fs.watch(this.#options.root, { recursive: true }, (_event, filename) => {
			if (!filename) return;
			const relativePath = filename.toString();
			if (shouldExclude(relativePath, this.#options.exclude)) return;
			this.#pendingChanges.add(relativePath);
			this.#scheduleTrigger();
		});
	}

	stop(): void {
		if (this.#debounceTimer) {
			clearTimeout(this.#debounceTimer);
			this.#debounceTimer = null;
		}
		if (this.#watcher) {
			this.#watcher.close();
			this.#watcher = null;
		}
		this.#pendingChanges.clear();
	}

	#scheduleTrigger(): void {
		if (this.#debounceTimer) {
			clearTimeout(this.#debounceTimer);
		}
		this.#debounceTimer = setTimeout(() => {
			const changes = [...this.#pendingChanges];
			this.#pendingChanges.clear();
			this.#debounceTimer = null;
			if (changes.length > 0) {
				this.#options.onChange(changes);
			}
		}, this.#options.debounceMs);
	}
}

import { matchesKey, padding, truncateToWidth } from "@spell/pi-tui";
import { memorySince } from "./actions.js";
import type { TabPanel } from "./types.js";

type SinceItem = { id: string; file: string; mtime: number };

export class MemoryRecentTab implements TabPanel {
	#items: SinceItem[] = [];
	#selectedIndex = 0;
	#loading = false;
	#error: string | null = null;
	#repoRoot: string;
	#onRequestRender: () => void;
	#onSelectItem: ((id: string) => void) | null = null;
	#loadedOnce = false;
	#disposed = false;

	readonly title = "Recent";

	constructor(repoRoot: string, onRequestRender: () => void) {
		this.#repoRoot = repoRoot;
		this.#onRequestRender = onRequestRender;
	}

	setOnSelectItem(cb: (id: string) => void): void {
		this.#onSelectItem = cb;
	}

	activate(): void {
		if (!this.#loadedOnce) {
			this.#refresh();
		}
	}

	async #refresh(): Promise<void> {
		this.#loading = true;
		this.#error = null;
		this.#onRequestRender();

		try {
			const { added, modified } = await memorySince(
				this.#repoRoot,
				"1970-01-01T00:00:00Z",
			);
			if (this.#disposed) return;

			// Merge added + modified, dedupe by id, sort by mtime desc
			const seen = new Set<string>();
			const merged: SinceItem[] = [];
			for (const item of [...added, ...modified]) {
				if (!seen.has(item.id)) {
					seen.add(item.id);
					merged.push(item);
				}
			}
			merged.sort((a, b) => b.mtime - a.mtime);

			this.#items = merged.slice(0, 50);
			this.#selectedIndex = 0;
			this.#loadedOnce = true;
			this.#loading = false;
			this.#onRequestRender();
		} catch (e) {
			if (this.#disposed) return;
			this.#error = String(e);
			this.#loading = false;
			this.#onRequestRender();
		}
	}

	deactivate(): void {
		// No-op
	}

	render(width: number): string[] {
		const lines: string[] = [];

		lines.push(truncateToWidth("Recent memory entries (mtime desc)", width));
		lines.push("");

		if (this.#loading) {
			lines.push(padding(2) + "(loading…)");
			return lines;
		}

		if (this.#error !== null) {
			lines.push(padding(2) + `ERROR: ${this.#error}`);
			return lines;
		}

		if (this.#items.length === 0) {
			lines.push(padding(2) + "(no recent entries)");
			return lines;
		}

		for (let i = 0; i < this.#items.length; i++) {
			const item = this.#items[i];
			const marker = i === this.#selectedIndex ? "▶" : " ";
			const date = new Date(item.mtime)
				.toISOString()
				.slice(0, 16)
				.replace("T", " ");
			const basename = item.file.split("/").pop() ?? item.file;
			const line = `${marker} ${date} ${item.id} ${basename}`;
			lines.push(truncateToWidth(line, width));
		}

		return lines;
	}

	handleInput(data: string): void {
		if (this.#disposed) return;

		if (matchesKey(data, "up") || data === "k") {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
			this.#onRequestRender();
			return;
		}

		if (matchesKey(data, "down") || data === "j") {
			this.#selectedIndex = Math.min(
				this.#items.length - 1,
				this.#selectedIndex + 1,
			);
			this.#onRequestRender();
			return;
		}

		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			const item = this.#items[this.#selectedIndex];
			if (item) {
				this.#onSelectItem?.(item.id);
			}
			this.#onRequestRender();
			return;
		}
	}

	invalidate(): void {
		// No cache to invalidate
	}

	dispose(): void {
		this.#disposed = true;
	}
}

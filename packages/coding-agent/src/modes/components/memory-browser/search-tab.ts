import {
	matchesKey,
	padding,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { memorySearch } from "./actions.js";
import type { MemoryHit, TabPanel } from "./types.js";

export class MemorySearchTab implements TabPanel {
	#query = "";
	#hits: MemoryHit[] = [];
	#selectedIndex = 0;
	#loading = false;
	#error: string | null = null;
	#debounceTimer: ReturnType<typeof setTimeout> | null = null;
	#repoRoot: string;
	#onRequestRender: () => void;
	#onSelectHit: ((hit: MemoryHit) => void) | null = null;
	#disposed = false;

	readonly title = "Search";

	constructor(repoRoot: string, onRequestRender: () => void) {
		this.#repoRoot = repoRoot;
		this.#onRequestRender = onRequestRender;
	}

	setOnSelectHit(cb: (hit: MemoryHit) => void): void {
		this.#onSelectHit = cb;
	}

	activate(): void {
		if (this.#query.length > 0) {
			this.#scheduleSearch();
		}
	}

	deactivate(): void {
		if (this.#debounceTimer !== null) {
			clearTimeout(this.#debounceTimer);
			this.#debounceTimer = null;
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];

		// Line 1: query input
		const queryLine = `> ${this.#query}|`;
		lines.push(truncateToWidth(queryLine, width));

		// Line 2: blank
		lines.push("");

		// Hits or status
		if (this.#loading) {
			lines.push(padding(2) + "(searching…)");
		} else if (this.#error !== null) {
			lines.push(padding(2) + `ERROR: ${this.#error}`);
		} else if (this.#hits.length === 0) {
			if (this.#query.length === 0) {
				lines.push(padding(2) + "(type to search)");
			} else {
				lines.push(padding(2) + "(no results)");
			}
		} else {
			const maxHits = Math.min(this.#hits.length, 15);
			for (let i = 0; i < maxHits; i++) {
				const hit = this.#hits[i];
				const marker = i === this.#selectedIndex ? "▶" : " ";
				const id = hit.id;
				const score = hit.score.toFixed(3);
				const title = hit.title ?? "";
				const hitLine = `${marker} ${i + 1}. ${id} (${score}) ${title}`;
				lines.push(truncateToWidth(hitLine, width));
			}
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
				this.#hits.length - 1,
				this.#selectedIndex + 1,
			);
			this.#onRequestRender();
			return;
		}

		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			const hit = this.#hits[this.#selectedIndex];
			if (hit) {
				this.#onSelectHit?.(hit);
			}
			this.#onRequestRender();
			return;
		}

		if (matchesKey(data, "backspace")) {
			this.#query = this.#query.slice(0, -1);
			this.#scheduleSearch();
			this.#onRequestRender();
			return;
		}

		// Printable character
		if (data.length === 1 && data >= " " && data < "\x7f") {
			this.#query += data;
			this.#scheduleSearch();
			this.#onRequestRender();
		}
	}

	invalidate(): void {
		// No cache to invalidate
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#debounceTimer !== null) {
			clearTimeout(this.#debounceTimer);
			this.#debounceTimer = null;
		}
	}

	#scheduleSearch(): void {
		if (this.#debounceTimer !== null) {
			clearTimeout(this.#debounceTimer);
			this.#debounceTimer = null;
		}

		if (this.#query.length === 0) {
			this.#hits = [];
			this.#selectedIndex = 0;
			this.#error = null;
			return;
		}

		this.#debounceTimer = setTimeout(async () => {
			this.#loading = true;
			this.#onRequestRender();
			try {
				const { hits } = await memorySearch(this.#repoRoot, this.#query, {
					limit: 15,
				});
				if (this.#disposed) return;
				this.#hits = hits;
				this.#selectedIndex = 0;
				this.#loading = false;
				this.#error = null;
				this.#onRequestRender();
			} catch (e) {
				if (this.#disposed) return;
				this.#error = String(e);
				this.#loading = false;
				this.#onRequestRender();
			}
		}, 300);
	}
}

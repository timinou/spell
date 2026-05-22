import { matchesKey, padding, truncateToWidth } from "@oh-my-pi/pi-tui";
import { memorySince } from "./actions.js";
import type { TabPanel } from "./types.js";

type SinceResult = Awaited<ReturnType<typeof memorySince>>;
type SinceEntry = { id: string; category: "added" | "modified" };

export class MemorySinceTab implements TabPanel {
	#window: "24h" | "7d" = "24h";
	#result: SinceResult | null = null;
	#combined: SinceEntry[] = [];
	#selectedIndex = 0;
	#loading = false;
	#error: string | null = null;
	#repoRoot: string;
	#onRequestRender: () => void;
	#onSelectItem: ((id: string) => void) | null = null;
	#loadedOnce = false;
	#disposed = false;

	readonly title = "Since";

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
			const ms = this.#window === "24h" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
			const ts = new Date(Date.now() - ms).toISOString();
			const result = await memorySince(this.#repoRoot, ts);
			if (this.#disposed) return;

			this.#result = result;
			this.#buildCombined(result);
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

	#buildCombined(result: SinceResult): void {
		const combined: SinceEntry[] = [];
		const maxPerSection = 10;

		for (const item of result.added.slice(0, maxPerSection)) {
			combined.push({ id: item.id, category: "added" });
		}
		for (const item of result.modified.slice(0, maxPerSection)) {
			combined.push({ id: item.id, category: "modified" });
		}
		this.#combined = combined;
	}

	deactivate(): void {
		// No-op
	}

	render(width: number): string[] {
		const lines: string[] = [];

		// Window toggle
		const windowLine =
			this.#window === "24h"
				? "[24h]  7d  (Space to toggle)"
				: "24h  [7d]  (Space to toggle)";
		lines.push(truncateToWidth(windowLine, width));

		// Blank
		lines.push("");

		if (this.#loading) {
			lines.push(padding(2) + "(loading…)");
			return lines;
		}

		if (this.#error !== null) {
			lines.push(padding(2) + `ERROR: ${this.#error}`);
			return lines;
		}

		if (this.#result === null) {
			lines.push(padding(2) + "(no data)");
			return lines;
		}

		const result = this.#result;
		let flatIndex = 0;

		// Added section
		lines.push(`Added (${result.added.length}):`);
		if (result.added.length === 0) {
			lines.push(padding(2) + "(none)");
		} else {
			const maxAdded = Math.min(result.added.length, 10);
			for (let i = 0; i < maxAdded; i++) {
				const item = result.added[i];
				const marker = flatIndex === this.#selectedIndex ? "▶" : " ";
				lines.push(truncateToWidth(`${marker} ${item.id}`, width));
				flatIndex++;
			}
		}

		// Modified section
		lines.push(`Modified (${result.modified.length}):`);
		if (result.modified.length === 0) {
			lines.push(padding(2) + "(none)");
		} else {
			const maxModified = Math.min(result.modified.length, 10);
			for (let i = 0; i < maxModified; i++) {
				const item = result.modified[i];
				const marker = flatIndex === this.#selectedIndex ? "▶" : " ";
				lines.push(truncateToWidth(`${marker} ${item.id}`, width));
				flatIndex++;
			}
		}

		// Deleted section
		if (result.deleted.length > 0) {
			lines.push(`Deleted (${result.deleted.length}):`);
			const maxDeleted = Math.min(result.deleted.length, 10);
			const deletedLine = result.deleted.slice(0, maxDeleted).join(", ");
			lines.push(truncateToWidth(padding(2) + deletedLine, width));
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
				this.#combined.length - 1,
				this.#selectedIndex + 1,
			);
			this.#onRequestRender();
			return;
		}

		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			const entry = this.#combined[this.#selectedIndex];
			if (entry) {
				this.#onSelectItem?.(entry.id);
			}
			this.#onRequestRender();
			return;
		}

		if (data === " ") {
			this.#window = this.#window === "24h" ? "7d" : "24h";
			this.#refresh();
		}
	}

	invalidate(): void {
		// No cache to invalidate
	}

	dispose(): void {
		this.#disposed = true;
	}
}

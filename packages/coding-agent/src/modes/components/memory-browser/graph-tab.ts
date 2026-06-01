import {
	matchesKey,
	padding,
	truncateToWidth,
	visibleWidth,
} from "@spell/pi-tui";
import { memoryAbout } from "./actions.js";
import type { TabPanel } from "./types.js";

type AboutResult = Awaited<ReturnType<typeof memoryAbout>>;

export class MemoryGraphTab implements TabPanel {
	#focusId: string | null = null;
	#about: AboutResult | null = null;
	#selectedIndex = 0;
	#loading = false;
	#error: string | null = null;
	#repoRoot: string;
	#onRequestRender: () => void;
	#onSelectNeighbor: ((id: string) => void) | null = null;
	#disposed = false;

	readonly title = "Graph";

	constructor(repoRoot: string, onRequestRender: () => void) {
		this.#repoRoot = repoRoot;
		this.#onRequestRender = onRequestRender;
	}

	setOnSelectNeighbor(cb: (id: string) => void): void {
		this.#onSelectNeighbor = cb;
	}

	async setFocus(id: string): Promise<void> {
		this.#focusId = id;
		this.#loading = true;
		this.#error = null;
		this.#onRequestRender();

		try {
			const about = await memoryAbout(this.#repoRoot, id);
			if (this.#disposed) return;
			this.#about = about;
			this.#selectedIndex = 0;
			this.#loading = false;
			this.#onRequestRender();
		} catch (e) {
			if (this.#disposed) return;
			this.#error = String(e);
			this.#loading = false;
			this.#about = null;
			this.#onRequestRender();
		}
	}

	activate(): void {
		// No-op; graph tab loads via setFocus
	}

	deactivate(): void {
		// No-op
	}

	render(width: number): string[] {
		const lines: string[] = [];

		// Line 1: focus
		const focusLine =
			this.#focusId !== null
				? `Focus: ${this.#focusId}`
				: "Focus: (none — select a hit on Search tab)";
		lines.push(truncateToWidth(focusLine, width));

		// Line 2: blank
		lines.push("");

		if (this.#loading) {
			lines.push(padding(2) + "(loading…)");
			return lines;
		}

		if (this.#error !== null) {
			lines.push(padding(2) + `ERROR: ${this.#error}`);
			return lines;
		}

		if (this.#about === null || this.#focusId === null) {
			lines.push(padding(2) + "(no focus selected)");
			return lines;
		}

		// Node info
		const node = this.#about.node;
		if (node) {
			const nodeTitle = `Title: ${node.title ?? "(no title)"}  Kind: ${node.kind ?? "?"}`;
			lines.push(truncateToWidth(nodeTitle, width));
		}

		// Neighbors header
		const neighbors = this.#about.neighbors;
		lines.push(`Neighbors (${neighbors.length}):`);

		// Neighbors list
		if (neighbors.length === 0) {
			lines.push(padding(2) + "(none)");
		} else {
			const maxNeighbors = Math.min(neighbors.length, 15);
			for (let i = 0; i < maxNeighbors; i++) {
				const nb = neighbors[i];
				const marker = i === this.#selectedIndex ? "▶" : " ";
				const viaLabel = nb.via === "in" ? "←" : "→";
				const neighborLine = `${marker} ${i + 1}. ${nb.id} — ${nb.kind} (${viaLabel})`;
				lines.push(truncateToWidth(neighborLine, width));
			}
		}

		// Lineage
		const lineage = this.#about.lineage;
		if (lineage.length > 0) {
			const lineageLine = `Lineage: ${lineage.join(" ← ")}`;
			lines.push(truncateToWidth(lineageLine, width));
		}

		return lines;
	}

	handleInput(data: string): void {
		if (this.#disposed) return;
		if (this.#about === null) return;

		const neighbors = this.#about.neighbors;

		if (matchesKey(data, "up") || data === "k") {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
			this.#onRequestRender();
			return;
		}

		if (matchesKey(data, "down") || data === "j") {
			this.#selectedIndex = Math.min(
				neighbors.length - 1,
				this.#selectedIndex + 1,
			);
			this.#onRequestRender();
			return;
		}

		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			const nb = neighbors[this.#selectedIndex];
			if (nb) {
				this.#onSelectNeighbor?.(nb.id);
			}
			this.#onRequestRender();
			return;
		}

		if (data === " ") {
			// Space — refresh current focus
			const focusId = this.#focusId;
			if (focusId !== null) {
				this.setFocus(focusId);
			}
		}
	}

	invalidate(): void {
		// No cache to invalidate
	}

	dispose(): void {
		this.#disposed = true;
	}
}

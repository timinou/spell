import {
	type Component,
	matchesKey,
	padding,
	truncateToWidth,
	visibleWidth,
} from "@spell/pi-tui";
import { MemoryBrowserTab, type MemoryBrowserOptions, type TabPanel } from "./types.js";

const PANEL_MIN_HEIGHT = 20;
const TAB_NAMES: Record<MemoryBrowserTab, string> = {
	[MemoryBrowserTab.Search]: "Search",
	[MemoryBrowserTab.Graph]: "Graph",
	[MemoryBrowserTab.Recent]: "Recent",
	[MemoryBrowserTab.Since]: "Since",
};

export class MemoryBrowserComponent implements Component {
	#opts: MemoryBrowserOptions;
	#tabs: readonly [TabPanel, TabPanel, TabPanel, TabPanel];
	#activeTab: MemoryBrowserTab = MemoryBrowserTab.Search;
	#disposed = false;

	constructor(opts: MemoryBrowserOptions, tabs: readonly [TabPanel, TabPanel, TabPanel, TabPanel]) {
		this.#opts = opts;
		this.#tabs = tabs;
	}

	handleInput(data: string): void {
		if (this.#disposed) return;

		// Close
		if (matchesKey(data, "escape") || matchesKey(data, "esc")) {
			this.#opts.onClose();
			return;
		}

		// Tab cycling
		if (matchesKey(data, "tab")) {
			this.#switchTab(this.#nextTab(1));
			return;
		}
		if (matchesKey(data, "shift+tab")) {
			this.#switchTab(this.#nextTab(-1));
			return;
		}

		// Delegate to active tab
		this.#tabs[this.#activeTab].handleInput?.(data);
		this.#opts.onRequestRender();
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		const bodyHeight = Math.max(3, PANEL_MIN_HEIGHT - 6);

		const lines: string[] = [];

		// Top chrome
		const topLabel = " Memory Browser ";
		const topGap = Math.max(1, innerWidth - visibleWidth(topLabel));
		lines.push(`╔═${topLabel}${"═".repeat(topGap)}╗`);

		// Tab strip
		lines.push(this.#renderTabStrip(innerWidth));

		// Inner separator
		lines.push(`║${"─".repeat(innerWidth)}║`);

		// Delegate content to active tab
		const content = this.#tabs[this.#activeTab].render(innerWidth);
		for (const line of content.slice(0, bodyHeight)) {
			const truncated = truncateToWidth(line, innerWidth);
			const remaining = Math.max(0, innerWidth - visibleWidth(truncated));
			lines.push(`║${truncated}${padding(remaining)}║`);
		}
		// Pad remaining rows
		for (let i = content.length; i < bodyHeight; i++) {
			lines.push(`║${padding(innerWidth)}║`);
		}

		// Bottom separator
		lines.push(`║${"─".repeat(innerWidth)}║`);

		// Legend
		const legend = " Tab/Shift+Tab: cycle | j/k: nav | Enter: open | Esc: close ";
		const legendTruncated = truncateToWidth(legend, innerWidth);
		const legendRemaining = Math.max(0, innerWidth - visibleWidth(legendTruncated));
		lines.push(`║${legendTruncated}${padding(legendRemaining)}║`);

		// Bottom chrome
		lines.push(`╚${"═".repeat(innerWidth)}╝`);

		return lines;
	}

	invalidate(): void {
		for (const tab of this.#tabs) {
			tab.invalidate?.();
		}
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const tab of this.#tabs) {
			tab.dispose?.();
		}
	}

	get activeTab(): MemoryBrowserTab {
		return this.#activeTab;
	}

	setActiveTab(tab: MemoryBrowserTab): void {
		this.#switchTab(tab);
	}

	// -- Private helpers --

	#switchTab(next: MemoryBrowserTab): void {
		if (next === this.#activeTab) return;
		this.#tabs[this.#activeTab].deactivate();
		this.#activeTab = next;
		this.#tabs[this.#activeTab].activate();
		this.#opts.onRequestRender();
	}

	#nextTab(direction: 1 | -1): MemoryBrowserTab {
		if (direction === 1) {
			return this.#activeTab === MemoryBrowserTab.Since
				? MemoryBrowserTab.Search
				: (this.#activeTab + 1) as MemoryBrowserTab;
		}
		return this.#activeTab === MemoryBrowserTab.Search
			? MemoryBrowserTab.Since
			: (this.#activeTab - 1) as MemoryBrowserTab;
	}

	#renderTabStrip(innerWidth: number): string {
		const parts: string[] = [];
		for (const [enumVal, label] of Object.entries(TAB_NAMES)) {
			const tabIndex = Number(enumVal) as MemoryBrowserTab;
			if (tabIndex === this.#activeTab) {
				parts.push(`[${label}]`);
			} else {
				parts.push(` ${label} `);
			}
		}
		const strip = parts.join("  ");
		const truncated = truncateToWidth(strip, innerWidth);
		const remaining = Math.max(0, innerWidth - visibleWidth(truncated));
		return `║${truncated}${padding(remaining)}║`;
	}
}

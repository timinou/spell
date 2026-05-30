import type { Component } from "@spell/pi-tui";

export enum MemoryBrowserTab {
	Search = 0,
	Graph = 1,
	Recent = 2,
	Since = 3,
}

export interface MemoryBrowserOptions {
	cwd: string;
	onClose: () => void;
	onRequestRender: () => void;
}

/** Contract that each tab implements. The browser composes 4 of these. */
export interface TabPanel extends Component {
	/** Called by browser when user switches into this tab. */
	activate(): void;
	/** Called by browser when user switches out. */
	deactivate(): void;
	/** Title shown in the tab strip. */
	readonly title: string;
	/** Optional cleanup on browser close. */
	dispose?(): void;
}

export interface MemoryHit {
	id: string;
	title?: string;
	kind?: string;
	score: number;
}

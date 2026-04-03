import type { SyncSettings, SyncTarget } from "../config/types";

export type SyncEventType = "push" | "pull";

export interface SyncEvent {
	type: SyncEventType;
	timestamp: number;
	files?: string[];
}

export interface WatchOptions {
	target: SyncTarget;
	sync: SyncSettings;
	localRoot: string;
	/** Callback when sync event occurs */
	onSync?: (event: SyncEvent) => void;
	/** Callback on error */
	onError?: (error: Error) => void;
}

export interface WatchState {
	running: boolean;
	lastPush?: SyncEvent;
	lastPull?: SyncEvent;
	pushCount: number;
	pullCount: number;
}

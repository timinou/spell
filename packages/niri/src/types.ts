/** Raw events emitted by the Niri IPC EventStream */
export type NiriEvent =
	| { OverviewOpenedOrClosed: { is_open: boolean } }
	| { WorkspaceActivated: { id: number; focused: boolean } }
	| { WorkspacesChanged: { workspaces: unknown[] } }
	| { WindowFocusChanged: { id: number | null } }
	| Record<string, unknown>;

/** Distilled overview open/close state */
export interface OverviewState {
	isOpen: boolean;
}

export type {
	AgentStatus,
	OverviewSnapshot,
	TodoItemSnapshot,
	TodoPhaseSnapshot,
} from "@spell/pi-desktop-common";

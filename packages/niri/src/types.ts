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

/** Snapshot of agent state used by the overview overlay */
export type AgentStatus = "idle" | "running" | "needs_input" | "error" | "completed" | "pending_approval";

/** Data snapshot passed to the overlay component for rendering */
export interface OverviewSnapshot {
	projectName: string;
	sessionTitle: string;
	messageCount: number;
	todoPhases: import("./controller.ts").TodoPhaseSnapshot[];
	agentStatus: AgentStatus;
}

/** Minimal view of a todo item for the overlay */
export interface TodoItemSnapshot {
	content: string;
	status: "pending" | "in_progress" | "completed" | "abandoned";
}

/** Minimal view of a todo phase for the overlay */
export interface TodoPhaseSnapshot {
	name: string;
	tasks: TodoItemSnapshot[];
}

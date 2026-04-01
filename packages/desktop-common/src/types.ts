/** Agent status derived from session state. Shared across all desktop integrations. */
export type AgentStatus =
	| "idle"
	| "running"
	| "needs_input"
	| "user_paused"
	| "error"
	| "completed"
	| "pending_approval";

/** Minimal snapshot of a todo task visible to desktop overlays. */
export interface TodoItemView {
	id: string;
	content: string;
	status: "pending" | "in_progress" | "completed" | "abandoned";
	blockers?: string[];
	gateCommit?: boolean;
	gateArtifact?: string;
	gateCmd?: string;
	gateLlm?: string;
	verifyCmd?: string;
	orgItemId?: string;
}

/** Minimal snapshot of a todo phase visible to desktop overlays. */
export interface TodoPhaseView {
	id?: string;
	name: string;
	tasks: TodoItemView[];
}

/** Snapshot of a single todo item for overlay rendering (resolved blockers/gates). */
export interface TodoItemSnapshot {
	id: string;
	content: string;
	status: "pending" | "in_progress" | "completed" | "abandoned";
	blocked: boolean;
	blockerLabels?: string[];
	gateBadges?: string[];
	orgItemId?: string;
}

/** Snapshot of a single todo phase for overlay rendering. */
export interface TodoPhaseSnapshot {
	name: string;
	tasks: TodoItemSnapshot[];
	/** Total done tasks — completed + abandoned, both in-data and auto-cleared. */
	doneCount: number;
}

/** Data snapshot passed to overlay components for rendering. */
export interface OverviewSnapshot {
	projectName: string;
	sessionTitle: string;
	messageCount: number;
	todoPhases: TodoPhaseSnapshot[];
	agentStatus: AgentStatus;
}

/** Status file written per session to ~/.spell/status/<windowId>.json */
export interface SessionStatusFile {
	status: AgentStatus;
	windowId: number | string;
	pid: number;
	projectName: string;
	sessionTitle: string;
	updatedAt: number;
}

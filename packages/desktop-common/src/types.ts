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
	status: "pending" | "in_progress" | "completed" | "abandoned" | "failed" | "gate_failed";
	blockers?: string[];
	gateCommit?: boolean;
	gateArtifact?: string;
	gateCmd?: string;
	gateLlm?: string;
	verifyCmd?: string;
	orgItemId?: string;
	childPhases?: TodoPhaseView[];
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
	status: "pending" | "in_progress" | "completed" | "abandoned" | "failed" | "gate_failed";
	blocked: boolean;
	blockerLabels?: string[];
	gateBadges?: string[];
	orgItemId?: string;
	childPhases?: TodoPhaseSnapshot[];
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

/** Status file written per session to ~/.spell/status/<sessionId>.json */
export interface SessionStatusFile {
	status: AgentStatus;
	/**
	 * Stable session identity — the primary key. Status files are named
	 * `<sessionId>.json`, and the desktop layer joins a niri window to its
	 * session by matching the `⟨sessionId⟩` token in the window title. Required
	 * for all files this version writes.
	 */
	sessionId: string;
	pid: number;
	projectName: string;
	sessionTitle: string;
	updatedAt: number;
	/**
	 * Legacy: the niri window id this session guessed for itself. No longer
	 * written (the window↔session mapping is now derived live from title tokens),
	 * but still read so status files from an older running spell keep rendering
	 * until that session restarts.
	 */
	windowId?: number | string;
	sessionFile?: string;
	cwd?: string;
	/**
	 * Last-known workspace name, a snapshot for `spell recover` to respawn a
	 * crashed session on the right workspace (its window is gone, so this can't be
	 * derived live). Resolved by the session's own title-token self-join.
	 */
	workspaceName?: string | null;
}

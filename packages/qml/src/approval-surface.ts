import type { SharedSyncState } from "./shared-sync-state";

export interface ApprovalSurfaceEntry {
	id: string;
	kind: string;
	title: string;
	state: string;
	allowedActions: string[];
	artifactCount: number;
}

export interface ApprovalSurfaceModel {
	pendingCount: number;
	completedCount: number;
	entries: ApprovalSurfaceEntry[];
}

export function buildApprovalSurfaceModel(state: SharedSyncState): ApprovalSurfaceModel {
	const entries = [...state.approvals, ...state.checkpoints]
		.map(item => ({
			id: String(item.id ?? ""),
			kind: String(item.kind ?? "approval"),
			title: String(item.title ?? ""),
			state: String(item.state ?? "pending"),
			allowedActions: Array.isArray(item.allowedActions)
				? item.allowedActions.filter(action => typeof action === "string")
				: [],
			artifactCount: typeof item.artifactCount === "number" ? item.artifactCount : 0,
		}))
		.sort((left, right) => left.title.localeCompare(right.title));
	return {
		pendingCount: entries.filter(entry => entry.state === "pending").length,
		completedCount: entries.filter(entry => entry.state !== "pending").length,
		entries,
	};
}

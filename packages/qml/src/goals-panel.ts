import type { SharedSyncState } from "./shared-sync-state";

export interface GoalsPanelEntry {
	id: string;
	state: string;
	title?: string;
}

export interface GoalsPanelModel {
	goalCount: number;
	statusCounts: Record<string, number>;
	entries: GoalsPanelEntry[];
}

export function buildGoalsPanelModel(state: SharedSyncState): GoalsPanelModel {
	const entries = state.goals
		.map(goal => ({
			id: goal.id,
			state: typeof goal.data.state === "string" ? goal.data.state : "unknown",
			title: typeof goal.data.title === "string" ? goal.data.title : undefined,
		}))
		.sort((left, right) => left.id.localeCompare(right.id));
	const statusCounts: Record<string, number> = {};
	for (const entry of entries) {
		statusCounts[entry.state] = (statusCounts[entry.state] ?? 0) + 1;
	}
	return {
		goalCount: entries.length,
		statusCounts,
		entries,
	};
}

import type { AgentStatus, OverviewSnapshot, TodoPhaseView } from "./types";
/** Context required to build an overview snapshot. */
export interface SnapshotContext {
    projectName: string;
    sessionTitle: string;
    messageCount: number;
    agentStatus: AgentStatus;
    todoPhases: TodoPhaseView[];
    /** Counts of auto-cleared completed tasks per phase ID. */
    clearedCompletedCounts?: ReadonlyMap<string, {
        name: string;
        count: number;
    }>;
}
/** Build an OverviewSnapshot from session context, resolving blocker/gate metadata. */
export declare function buildOverviewSnapshot(ctx: SnapshotContext): OverviewSnapshot;
//# sourceMappingURL=snapshot.d.ts.map
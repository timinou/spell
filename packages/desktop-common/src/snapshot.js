function buildTaskSnapshot(task, taskById) {
    const blockerIds = task.blockers ?? [];
    const blocked = blockerIds.length > 0 &&
        task.status !== "completed" &&
        task.status !== "abandoned" &&
        blockerIds.some(blockerId => {
            const dependency = taskById.get(blockerId);
            return !!dependency && dependency.status !== "completed" && dependency.status !== "abandoned";
        });
    const blockerLabels = blockerIds
        .filter(blockerId => {
        const dependency = taskById.get(blockerId);
        return !!dependency && dependency.status !== "completed" && dependency.status !== "abandoned";
    })
        .map(blockerId => taskById.get(blockerId)?.content)
        .filter((content) => content !== undefined);
    const gateBadges = [];
    if (task.gateCommit)
        gateBadges.push("commit");
    if (task.gateCmd)
        gateBadges.push("cmd");
    if (task.gateArtifact)
        gateBadges.push("artifact");
    if (task.gateLlm)
        gateBadges.push("llm");
    if (task.verifyCmd)
        gateBadges.push("verify");
    return {
        id: task.id,
        content: task.content,
        status: task.status,
        blocked,
        blockerLabels: blockerLabels.length > 0 ? blockerLabels : undefined,
        gateBadges: gateBadges.length > 0 ? gateBadges : undefined,
        orgItemId: task.orgItemId,
        childPhases: task.childPhases ? buildPhaseSnapshots(task.childPhases) : undefined,
    };
}
function buildPhaseSnapshots(phases, clearedCounts, activePhaseIds) {
    const allTasks = phases.flatMap(phase => phase.tasks);
    const taskById = new Map(allTasks.map(task => [task.id, task]));
    const snapshots = phases.map(phase => {
        if (activePhaseIds && phase.id)
            activePhaseIds.add(phase.id);
        const clearedForPhase = clearedCounts && phase.id ? (clearedCounts.get(phase.id)?.count ?? 0) : 0;
        const inDataCompleted = phase.tasks.filter(task => task.status === "completed" || task.status === "abandoned").length;
        return {
            name: phase.name,
            doneCount: inDataCompleted + clearedForPhase,
            tasks: phase.tasks.map(task => buildTaskSnapshot(task, taskById)),
        };
    });
    if (clearedCounts && activePhaseIds) {
        for (const [phaseId, { name, count }] of clearedCounts) {
            if (!activePhaseIds.has(phaseId)) {
                snapshots.push({ name, tasks: [], doneCount: count });
            }
        }
    }
    return snapshots;
}
/** Build an OverviewSnapshot from session context, resolving blocker/gate metadata. */
export function buildOverviewSnapshot(ctx) {
    const clearedCounts = ctx.clearedCompletedCounts ?? new Map();
    const activePhaseIds = new Set();
    return {
        projectName: ctx.projectName,
        sessionTitle: ctx.sessionTitle,
        messageCount: ctx.messageCount,
        todoPhases: buildPhaseSnapshots(ctx.todoPhases, clearedCounts, activePhaseIds),
        agentStatus: ctx.agentStatus,
    };
}
//# sourceMappingURL=snapshot.js.map
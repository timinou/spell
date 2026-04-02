/** Build an OverviewSnapshot from session context, resolving blocker/gate metadata. */
export function buildOverviewSnapshot(ctx) {
    // Build a flat task-id lookup across all phases for blocker resolution.
    const allTasks = ctx.todoPhases.flatMap(p => p.tasks);
    const taskById = new Map(allTasks.map(t => [t.id, t]));
    const clearedCounts = ctx.clearedCompletedCounts ?? new Map();
    const activePhaseIds = new Set();
    const todoPhases = ctx.todoPhases.map(p => {
        if (p.id)
            activePhaseIds.add(p.id);
        const clearedForPhase = p.id ? (clearedCounts.get(p.id)?.count ?? 0) : 0;
        const inDataCompleted = p.tasks.filter(t => t.status === "completed" || t.status === "abandoned").length;
        return {
            name: p.name,
            doneCount: inDataCompleted + clearedForPhase,
            tasks: p.tasks.map(t => {
                const blockerIds = t.blockers ?? [];
                const blocked = blockerIds.length > 0 &&
                    t.status !== "completed" &&
                    t.status !== "abandoned" &&
                    blockerIds.some(bid => {
                        const dep = taskById.get(bid);
                        return !!dep && dep.status !== "completed" && dep.status !== "abandoned";
                    });
                const blockerLabels = blockerIds
                    .filter(bid => {
                    const dep = taskById.get(bid);
                    return !!dep && dep.status !== "completed" && dep.status !== "abandoned";
                })
                    .map(bid => taskById.get(bid)?.content)
                    .filter((c) => c !== undefined);
                const gateBadges = [];
                if (t.gateCommit)
                    gateBadges.push("commit");
                if (t.gateCmd)
                    gateBadges.push("cmd");
                if (t.gateArtifact)
                    gateBadges.push("artifact");
                if (t.gateLlm)
                    gateBadges.push("llm");
                if (t.verifyCmd)
                    gateBadges.push("verify");
                return {
                    id: t.id,
                    content: t.content,
                    status: t.status,
                    blocked,
                    blockerLabels: blockerLabels.length > 0 ? blockerLabels : undefined,
                    gateBadges: gateBadges.length > 0 ? gateBadges : undefined,
                    orgItemId: t.orgItemId,
                };
            }),
        };
    });
    // Add phantom phases for fully-cleared phases no longer in active data.
    for (const [phaseId, { name, count }] of clearedCounts) {
        if (!activePhaseIds.has(phaseId)) {
            todoPhases.push({ name, tasks: [], doneCount: count });
        }
    }
    return {
        projectName: ctx.projectName,
        sessionTitle: ctx.sessionTitle,
        messageCount: ctx.messageCount,
        todoPhases,
        agentStatus: ctx.agentStatus,
    };
}
//# sourceMappingURL=snapshot.js.map
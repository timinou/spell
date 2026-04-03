import { WorkflowEngine } from "../../src/workflow";
import type {
	WorkflowActionDefinition,
	WorkflowActor,
	WorkflowCreateCheckpointInput,
	WorkflowCreateItemInput,
} from "../../src/workflow/types";

export function createClock(initial = "2026-04-02T00:00:00.000Z"): {
	now: () => Date;
	advanceMs: (ms: number) => void;
} {
	let current = new Date(initial);
	return {
		now: () => new Date(current),
		advanceMs(ms: number) {
			current = new Date(current.getTime() + ms);
		},
	};
}

export function createActor(actorId: string, roles?: string[]): WorkflowActor {
	return {
		actorId,
		source: "test",
		...(roles ? { roles } : {}),
	};
}

export function createApprovalActions(): WorkflowActionDefinition[] {
	return [
		{ id: "approve", label: "Approve", fromStates: ["pending"], toState: "approved" },
		{ id: "reject", label: "Reject", fromStates: ["pending"], toState: "rejected", requiresReason: true },
		{ id: "defer", label: "Defer", fromStates: ["pending"], toState: "deferred" },
	];
}

export function createCheckpointActions(): WorkflowActionDefinition[] {
	return [
		{
			id: "resume",
			label: "Resume",
			fromStates: ["pending"],
			toState: "completed",
			checkpointEffect: { type: "resume-run" },
		},
		{
			id: "fail-run",
			label: "Fail run",
			fromStates: ["pending"],
			toState: "failed",
			requiresReason: true,
			checkpointEffect: { type: "fail-run" },
		},
		{
			id: "trigger-followup",
			label: "Trigger follow-up",
			fromStates: ["pending"],
			toState: "completed",
			checkpointEffect: { type: "trigger-goal", goalName: "publish-approved" },
		},
		{
			id: "request-another-approval",
			label: "Create another approval",
			fromStates: ["pending"],
			toState: "completed",
			checkpointEffect: {
				type: "create-approval",
				approval: {
					workflowId: "growth",
					targetId: "article-1",
					title: "Follow-up approval",
					actions: createApprovalActions(),
				},
			},
		},
	];
}

export function createApprovalInput(overrides: Partial<WorkflowCreateItemInput> = {}): WorkflowCreateItemInput {
	return {
		workflowId: "growth",
		targetId: "article-1",
		title: "Approve article",
		actions: createApprovalActions(),
		...(overrides.summary !== undefined ? { summary: overrides.summary } : {}),
		...(overrides.initialState !== undefined ? { initialState: overrides.initialState } : {}),
		...(overrides.metadata !== undefined ? { metadata: overrides.metadata } : {}),
		...(overrides.artifacts !== undefined ? { artifacts: overrides.artifacts } : {}),
		...(overrides.notificationRoutes !== undefined ? { notificationRoutes: overrides.notificationRoutes } : {}),
		...(overrides.claimLeaseMs !== undefined ? { claimLeaseMs: overrides.claimLeaseMs } : {}),
		...(overrides.linkedGoal !== undefined ? { linkedGoal: overrides.linkedGoal } : {}),
		...(overrides.linkedRunId !== undefined ? { linkedRunId: overrides.linkedRunId } : {}),
		...(overrides.linkedCheckpointId !== undefined ? { linkedCheckpointId: overrides.linkedCheckpointId } : {}),
		...(overrides.workflowId !== undefined ? { workflowId: overrides.workflowId } : {}),
		...(overrides.targetId !== undefined ? { targetId: overrides.targetId } : {}),
		...(overrides.title !== undefined ? { title: overrides.title } : {}),
		...(overrides.actions !== undefined ? { actions: overrides.actions } : {}),
	};
}

export function createCheckpointInput(
	overrides: Partial<WorkflowCreateCheckpointInput> = {},
): WorkflowCreateCheckpointInput {
	return {
		workflowId: "growth",
		targetId: "article-1",
		title: "Checkpoint",
		actions: createCheckpointActions(),
		runStatus: "paused",
		...(overrides.summary !== undefined ? { summary: overrides.summary } : {}),
		...(overrides.initialState !== undefined ? { initialState: overrides.initialState } : {}),
		...(overrides.metadata !== undefined ? { metadata: overrides.metadata } : {}),
		...(overrides.artifacts !== undefined ? { artifacts: overrides.artifacts } : {}),
		...(overrides.notificationRoutes !== undefined ? { notificationRoutes: overrides.notificationRoutes } : {}),
		...(overrides.claimLeaseMs !== undefined ? { claimLeaseMs: overrides.claimLeaseMs } : {}),
		...(overrides.linkedGoal !== undefined ? { linkedGoal: overrides.linkedGoal } : {}),
		...(overrides.linkedRunId !== undefined ? { linkedRunId: overrides.linkedRunId } : {}),
		...(overrides.linkedCheckpointId !== undefined ? { linkedCheckpointId: overrides.linkedCheckpointId } : {}),
		...(overrides.workflowId !== undefined ? { workflowId: overrides.workflowId } : {}),
		...(overrides.targetId !== undefined ? { targetId: overrides.targetId } : {}),
		...(overrides.title !== undefined ? { title: overrides.title } : {}),
		...(overrides.actions !== undefined ? { actions: overrides.actions } : {}),
		...(overrides.runStatus !== undefined ? { runStatus: overrides.runStatus } : {}),
	};
}

export function createWorkflowEngine(now?: () => Date): WorkflowEngine {
	return new WorkflowEngine({ now });
}

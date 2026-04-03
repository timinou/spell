import type { WorkflowActionDefinition } from "../../../spell-server/src/workflow";

export function createGrowthReviewApprovalActions(): WorkflowActionDefinition[] {
	return [
		{
			id: "approve-feed",
			label: "Approve for feed",
			fromStates: ["pending"],
			toState: "feed-approved",
			downstreamJobs: [{ kind: "feed-send" }],
		},
		{
			id: "approve-publication",
			label: "Approve for publication",
			fromStates: ["pending"],
			toState: "publication-approved",
			downstreamJobs: [{ kind: "publication-export" }],
		},
		{
			id: "reject",
			label: "Reject",
			fromStates: ["pending"],
			toState: "rejected",
			requiresReason: true,
		},
		{
			id: "defer",
			label: "Defer",
			fromStates: ["pending"],
			toState: "deferred",
		},
	];
}

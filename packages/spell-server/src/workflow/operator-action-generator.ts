import type { OperatorAction } from "../manifest/types";
import type {
	OperatorActionHandler,
	OperatorActionRequest,
	OperatorActionResult,
} from "../http/routes/operator-actions";
import type { WorkflowEngine } from "./engine";
import type { WorkflowActionDefinition } from "./types";

const WORKFLOW_ID = "operator-actions";

/**
 * Generate an OperatorActionHandler from manifest operator-action declarations.
 * Each operator-action maps to workflow engine transitions on per-article approval items.
 */
export function generateOperatorActionHandler(
	operatorActions: OperatorAction[],
	workflowEngine: WorkflowEngine,
): OperatorActionHandler {
	// Build a lookup of action-id → OperatorAction
	const actionMap = new Map<string, OperatorAction>();
	for (const action of operatorActions) {
		actionMap.set(action.id, action);
	}

	// Build WorkflowActionDefinitions from all operator-actions
	const workflowActions: WorkflowActionDefinition[] = operatorActions.map(oa => ({
		id: oa.id,
		label: oa.id,
		fromStates: oa.transitions.map(t => t.from),
		toState: oa.transitions[0].to, // primary target state
		...(oa.downstreamJob ? { downstreamJobs: [{ kind: oa.downstreamJob.kind }] } : {}),
	}));

	// Build a map of (from, action-id) → toState for multi-from transitions
	const transitionTable = new Map<string, string>();
	for (const oa of operatorActions) {
		for (const t of oa.transitions) {
			transitionTable.set(`${t.from}:${oa.id}`, t.to);
		}
	}

	return async (request: OperatorActionRequest): Promise<OperatorActionResult> => {
		const action = actionMap.get(request.action);
		if (!action) {
			return {
				articleId: request.articleId,
				workflowState: "unknown",
				triggeredGoals: [],
				duplicate: false,
				downstreamJobs: [],
			};
		}

		// Get or create the approval item for this article
		const itemId = `article:${request.articleId}`;
		let item = workflowEngine.listItems({ workflowId: WORKFLOW_ID }).find(i => i.targetId === request.articleId);

		if (!item) {
			item = workflowEngine.createApproval({
				workflowId: WORKFLOW_ID,
				targetId: request.articleId,
				title: `Article ${request.articleId}`,
				initialState: "pending",
				actions: workflowActions,
			});
		}

		// Resolve the correct toState for this (currentState, action) pair
		const targetState = transitionTable.get(`${item.state}:${request.action}`);
		if (!targetState) {
			// Action not valid from current state — return stale indicator
			return {
				articleId: request.articleId,
				workflowState: item.state,
				triggeredGoals: [],
				duplicate: false,
				downstreamJobs: [],
			};
		}

		// Build a temporary action definition with the correct toState for this specific transition
		const actionDef: WorkflowActionDefinition = {
			id: request.action,
			label: request.action,
			fromStates: action.transitions.map(t => t.from),
			toState: targetState,
			...(action.downstreamJob ? { downstreamJobs: [{ kind: action.downstreamJob.kind }] } : {}),
		};

		// Ensure the item has this action defined with the right toState
		const existingAction = item.actions.find(a => a.id === request.action);
		if (existingAction) {
			existingAction.toState = targetState;
		}

		// Claim the item for this actor before applying the action
		try {
			workflowEngine.claimItem({
				itemId: item.id,
				actor: {
					actorId: request.actor.userId,
					source: request.source,
				},
				requestId: request.requestId,
			});
		} catch {
			// Already claimed by same actor or we can proceed with force
		}

		const result = await workflowEngine.applyAction({
			itemId: item.id,
			actionId: request.action,
			actor: {
				actorId: request.actor.userId,
				source: request.source,
			},
			requestId: request.requestId,
		});

		const triggeredGoals: string[] = [];
		if (!result.duplicate && !result.stale && action.triggerGoal) {
			triggeredGoals.push(action.triggerGoal);
		}

		return {
			articleId: request.articleId,
			workflowState: result.item.state,
			triggeredGoals,
			duplicate: result.duplicate,
			downstreamJobs: result.queuedJobs.map(job => ({
				jobId: job.id,
				kind: job.kind as "feed-delivery" | "publication-export",
				status: job.status as "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED",
				retryEligible: job.retryEligible,
			})),
		};
	};
}

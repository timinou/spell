import type { WorkflowEngine } from "../workflow/engine";
import type { WorkflowActor, WorkflowApplyActionResult } from "../workflow/types";

export interface TelegramApprovalInboxEntry {
	itemId: string;
	title: string;
	state: string;
	actions: Array<{ id: string; label: string }>;
}

export function buildTelegramApprovalInbox(engine: WorkflowEngine): TelegramApprovalInboxEntry[] {
	return engine
		.listItems({ state: "pending" })
		.map(item => ({
			itemId: item.id,
			title: item.title,
			state: item.state,
			actions: item.actions
				.filter(action => action.fromStates.includes(item.state))
				.map(action => ({ id: action.id, label: action.label })),
		}))
		.sort((left, right) => left.title.localeCompare(right.title));
}

export async function applyTelegramQuickAction(
	engine: WorkflowEngine,
	input: { itemId: string; actionId: string; actor: WorkflowActor; requestId: string; reason?: string },
): Promise<WorkflowApplyActionResult> {
	engine.claimItem({
		itemId: input.itemId,
		actor: input.actor,
		requestId: `claim:${input.requestId}`,
	});
	return engine.applyAction({
		itemId: input.itemId,
		actionId: input.actionId,
		actor: input.actor,
		requestId: input.requestId,
		...(input.reason ? { reason: input.reason } : {}),
	});
}

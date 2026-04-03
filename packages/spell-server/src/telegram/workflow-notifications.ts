import type { WorkflowItem } from "../workflow/types";

export function buildWorkflowNotificationText(item: WorkflowItem): string {
	const kindLabel = item.kind === "checkpoint" ? "Checkpoint" : "Approval";
	return `${kindLabel}: ${item.title}\nState: ${item.state}\nTarget: ${item.targetId}`;
}

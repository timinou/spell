import { renderPromptTemplate } from "../config/prompt-templates";
import { resolveInjectText, type TaskPolicy } from "../config/task-policies";
import subagentPredecessorResultsTemplate from "../prompts/system/subagent-predecessor-results.md" with {
	type: "text",
};
import subagentUserPromptTemplate from "../prompts/system/subagent-user-prompt.md" with { type: "text" };
import { findTask, type TodoGroup } from "../tools/todo-write";
import type { TaskItem } from "./types";

interface RenderResult {
	/** Full task text sent to the subagent */
	task: string;
	/** Raw per-task assignment text, without prompt template boilerplate */
	assignment: string;
	id: string;
	description: string;
}

/**
 * Build the full task text from shared context and per-task assignment.
 *
 * If context is provided, it is prepended with a separator.
 */
export function renderTemplate(context: string | undefined, task: TaskItem): RenderResult {
	let { id, description, assignment } = task;
	assignment = assignment?.trim() ?? "";
	context = context?.trim();

	if (!context || !assignment) {
		return { task: assignment || context || "", assignment: assignment || context || "", id, description };
	}
	return {
		task: renderPromptTemplate(subagentUserPromptTemplate, { context, assignment }),
		assignment,
		id,
		description,
	};
}

/**
 * Resolve a todoRef against the current todo groups and build a verification
 * requirements section for the subagent. Returns undefined if the ref is
 * unresolvable or the todo has no gates worth injecting.
 */
export function resolveVerificationContext(
	todoRef: string,
	groups: TodoGroup[],
	policies?: TaskPolicy[],
): string | undefined {
	const task = findTask(groups, todoRef);
	if (!task) return undefined;

	const lines: string[] = [];
	if (task.gateCmd) lines.push(`You MUST run: \`${task.gateCmd}\` and verify it passes.`);
	if (task.gateArtifact) lines.push(`You MUST produce artifact at: ${task.gateArtifact}`);
	if (task.gateCommit) lines.push("You MUST commit changes before yielding.");
	if (task.gateLlm) lines.push(`You MUST self-review against: ${task.gateLlm}`);
	if (task.verifyCmd) lines.push(`You SHOULD run: \`${task.verifyCmd}\` to verify.`);
	if (task.orgItemClosingId) {
		lines.push(
			`You MUST update org item ${task.orgItemClosingId}: set to DOING at start, update with progress, and append completion report when done.`,
		);
	}
	if (task.orgItemId && !task.orgItemClosingId) {
		lines.push(`Linked to org item ${task.orgItemId} for lineage tracking (non-gating).`);
	}

	if (policies && task.layer) {
		const injectText = resolveInjectText(task.layer, policies);
		if (injectText) {
			lines.push("");
			lines.push(`--- Policy Guidance (layer: ${task.layer}) ---`);
			lines.push(injectText);
		}
	}

	if (lines.length === 0) return undefined;

	return `--- Verification Requirements (from ${todoRef}) ---\n${lines.join("\n")}`;
}

export function resolvePredecessorResultsContext(todoRef: string, groups: TodoGroup[]): string | undefined {
	const task = findTask(groups, todoRef);
	if (!task?.blockers?.length) return undefined;

	const predecessors = task.blockers
		.map(blockerId => findTask(groups, blockerId))
		.filter((blocker): blocker is NonNullable<typeof blocker> => blocker !== undefined)
		.filter(blocker => blocker.status === "completed" && blocker.delegation?.result !== undefined)
		.map(blocker => ({
			todoId: blocker.id,
			content: blocker.content,
			outputPath: blocker.delegation?.result?.outputPath,
			error: blocker.delegation?.result?.error,
			output: blocker.delegation?.result?.output,
		}));

	if (predecessors.length === 0) return undefined;

	return renderPromptTemplate(subagentPredecessorResultsTemplate, {
		todoRef,
		predecessors,
	});
}

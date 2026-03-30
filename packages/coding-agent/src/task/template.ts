import { renderPromptTemplate } from "../config/prompt-templates";
import subagentUserPromptTemplate from "../prompts/system/subagent-user-prompt.md" with { type: "text" };
import { findTask, type TodoPhase } from "../tools/todo-write";
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
	assignment = assignment.trim();
	context = context?.trim();

	if (!context || !assignment) {
		return { task: assignment || context!, assignment: assignment || context!, id, description };
	}
	return {
		task: renderPromptTemplate(subagentUserPromptTemplate, { context, assignment }),
		assignment,
		id,
		description,
	};
}

/**
 * Resolve a todoRef against the current todo phases and build a verification
 * requirements section for the subagent. Returns undefined if the ref is
 * unresolvable or the todo has no gates worth injecting.
 */
export function resolveVerificationContext(todoRef: string, phases: TodoPhase[]): string | undefined {
	const task = findTask(phases, todoRef);
	if (!task) return undefined;

	const lines: string[] = [];
	if (task.gateCmd) lines.push(`You MUST run: \`${task.gateCmd}\` and verify it passes.`);
	if (task.gateArtifact) lines.push(`You MUST produce artifact at: ${task.gateArtifact}`);
	if (task.gateCommit) lines.push("You MUST commit changes before yielding.");
	if (task.gateLlm) lines.push(`You MUST self-review against: ${task.gateLlm}`);
	if (task.verifyCmd) lines.push(`You SHOULD run: \`${task.verifyCmd}\` to verify.`);
	if (task.orgItemId) {
		lines.push(
			`You MUST update org item ${task.orgItemId}: set to DOING at start, update with progress, and append completion report when done.`,
		);
	}

	if (lines.length === 0) return undefined;

	return `--- Verification Requirements (from ${todoRef}) ---\n${lines.join("\n")}`;
}

import { renderPromptTemplate } from "../config/prompt-templates";
import { resolveInjectText, type TaskPolicy } from "../config/task-policies";
import subagentPredecessorResultsTemplate from "../prompts/system/subagent-predecessor-results.md" with {
	type: "text",
};
import subagentUserPromptTemplate from "../prompts/system/subagent-user-prompt.md" with { type: "text" };
import { findNode, type TodoNode } from "../tools/todo-write";
import { resolveRef } from "./ref-resolver";
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
 * Resolve a roster ref against the current todo groups and build a verification
 * requirements section for the subagent. Returns undefined if the ref is
 * unresolvable or the todo has no gates worth injecting.
 */
export function resolveVerificationContext(
	ref: string,
	nodes: TodoNode[],
	policies?: TaskPolicy[],
): string | undefined {
	const node = findNode(nodes, ref);
	if (!node) return undefined;

	const lines: string[] = [];
	if (node.verify?.cmd) lines.push(`You MUST run: \`${node.verify.cmd}\` and verify it passes.`);
	if (node.verify?.artifact) lines.push(`You MUST produce artifact at: ${node.verify.artifact}`);
	if (node.verificationArtifact) {
		lines.push(`Verification evidence will be persisted at: ${node.verificationArtifact}`);
	}
	if (node.verify?.commit) lines.push("You MUST commit changes before yielding.");
	if (node.verify?.review) lines.push(`You MUST self-review against: ${node.verify.review}`);
	const orgItemId = resolveRef(node.ref).kind === "org" ? (resolveRef(node.ref) as { itemId: string }).itemId : undefined;
	if (node.closesRef && orgItemId) {
		lines.push(
			`You MUST update org item ${orgItemId}: set to DOING at start, update with progress, and append completion report when done.`,
		);
	} else if (orgItemId) {
		lines.push(`Linked to org item ${orgItemId} for lineage tracking (non-gating).`);
	}

	if (policies && node.layer) {
		const injectText = resolveInjectText(node.layer, policies);
		if (injectText) {
			lines.push("");
			lines.push(`--- Policy Guidance (layer: ${node.layer}) ---`);
			lines.push(injectText);
		}
	}

	if (lines.length === 0) return undefined;

	return `--- Verification Requirements (from ${ref}) ---\n${lines.join("\n")}`;
}

export function resolvePredecessorResultsContext(ref: string, nodes: TodoNode[]): string | undefined {
	const node = findNode(nodes, ref);
	if (!node?.blockers?.length) return undefined;

	const predecessors = node.blockers
		.map(blockerId => findNode(nodes, blockerId))
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
		todoRef: ref,
		predecessors,
	});
}

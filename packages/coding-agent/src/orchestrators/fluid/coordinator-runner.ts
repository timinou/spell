import { logger } from "@oh-my-pi/pi-utils";
import { renderPromptTemplate } from "../../config/prompt-templates";
import coordinatorPromptTemplate from "../../prompts/agents/coordinator.md" with { type: "text" };
import type { SingleResult } from "../../task/types";
import type { FluidAgentNode } from "./types";

export interface CoordinatorContext {
	/** Function to spawn a subprocess agent session */
	runSubprocess: (prompt: string, signal?: AbortSignal) => Promise<SingleResult>;
	/** Parent plan's CUSTOM_ID */
	planId: string;
}

/** Run a coordinator agent for a sub-DAG component. */
export async function runCoordinator(
	node: FluidAgentNode,
	context: CoordinatorContext,
	signal?: AbortSignal,
): Promise<SingleResult> {
	if (!node.isCoordinator || !node.subPlan) {
		throw new Error(`runCoordinator called on non-coordinator node: ${node.id}`);
	}

	const { subPlan } = node;

	const subDagItems = subPlan.agents.map(a => ({
		id: a.orgItemId ?? a.id,
		task: a.task,
		dependsOn: a.dependsOn,
		effort: a.effort ?? "",
		priority: a.priority ?? "",
	}));

	const prompt = renderPromptTemplate(coordinatorPromptTemplate, {
		subDagItems,
		planId: context.planId,
		isSimple: subPlan.agents.length <= 2,
		itemCount: subPlan.agents.length,
	});

	logger.debug(`[coordinator-runner] Running coordinator for node=${node.id} items=${subPlan.agents.length}`);

	try {
		return await context.runSubprocess(prompt, signal);
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		logger.error(`[coordinator-runner] Subprocess failed for node=${node.id}: ${errorMessage}`);
		return {
			index: 0,
			id: node.id,
			agent: "coordinator",
			agentSource: "bundled",
			task: node.task,
			exitCode: 1,
			output: "",
			stderr: errorMessage,
			truncated: false,
			durationMs: 0,
			tokens: 0,
			error: errorMessage,
		};
	}
}

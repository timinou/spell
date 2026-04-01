import type { SingleResult } from "../../task/types";

export const CANVAS_OUTPUT_TYPES = ["markdown", "table", "diff", "tree", "log", "code", "progress"] as const;
export type CanvasOutputType = (typeof CANVAS_OUTPUT_TYPES)[number];

export interface FluidAgentNode {
	id: string;
	task: string;
	dependsOn: string[];
	canvasOutput?: {
		type: CanvasOutputType;
		title: string;
	};
	/** Org CUSTOM_ID of the item this agent represents. */
	orgItemId?: string;
	/** Estimated effort for this agent's work. */
	effort?: string;
	/** Priority level (A/B/C). */
	priority?: string;
	/** Whether this node should be skipped (FUP items deferred to a later cycle). */
	deferred?: boolean;
	/** Body text from the org item (scope/details). */
	body?: string;
	/** Whether this node is a coordinator managing a sub-DAG. */
	isCoordinator?: boolean;
	/** Sub-plan that this coordinator manages (only set when isCoordinator=true). */
	subPlan?: FluidPlan;
}

export interface FluidPlan {
	agents: FluidAgentNode[];
}

export type AgentState = "pending" | "ready" | "running" | "completed" | "failed";

export interface AgentRuntime {
	node: FluidAgentNode;
	state: AgentState;
	result?: SingleResult;
	error?: string;
	startedAt?: number;
	completedAt?: number;
}

export type FluidEvent =
	| { type: "plan_start" }
	| { type: "plan_complete"; plan: FluidPlan }
	| { type: "plan_error"; error: string }
	| {
			type: "agent_state_change";
			agentId: string;
			state: AgentState;
			result?: SingleResult;
			error?: string;
			startedAt?: number;
			completedAt?: number;
	  }
	| { type: "planner_stream"; text: string }
	| { type: "agent_stream"; agentId: string; text: string }
	| { type: "canvas_output"; agentId: string; outputType: CanvasOutputType; title: string; content: string }
	| { type: "execution_cancelled"; reason: string }
	| { type: "execution_complete"; results: Map<string, AgentRuntime> };

export const FLUID_EVENT_CHANNEL = "fluid:event";

import type { SingleResult } from "../../task/types";

export type CanvasOutputType = "markdown" | "table" | "diff" | "tree" | "log";

export interface FluidAgentNode {
	id: string;
	task: string;
	dependsOn: string[];
	canvasOutput?: {
		type: CanvasOutputType;
		title: string;
	};
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

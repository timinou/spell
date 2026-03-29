import type { GateDecision } from "../contracts";
import type { LoopGateConfig, LoopSnapshot } from "../types";

export interface GateExecutionContext {
	cwd: string;
	loop: LoopSnapshot;
	attemptNumber: number;
	evidence?: string[];
}

export interface ReviewResult {
	pass: boolean;
	summary: string;
	findings: string[];
}

export interface LoopReviewer {
	review(gate: LoopGateConfig, context: GateExecutionContext): Promise<ReviewResult>;
}

export interface GateExecutor<TGate extends LoopGateConfig = LoopGateConfig> {
	execute(gate: TGate, context: GateExecutionContext): Promise<GateDecision>;
}

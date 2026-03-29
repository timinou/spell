import { GATE_OUTCOMES } from "../../contracts";
import type { LlmReviewGateConfig } from "../../types";
import type { GateExecutionContext, GateExecutor, LoopReviewer } from "../types";

export class LlmReviewGateExecutor implements GateExecutor<LlmReviewGateConfig> {
	readonly #reviewer: LoopReviewer;

	constructor(reviewer: LoopReviewer) {
		this.#reviewer = reviewer;
	}

	async execute(gate: LlmReviewGateConfig, context: GateExecutionContext) {
		try {
			const result = await this.#reviewer.review(gate, context);
			if (
				typeof result.pass !== "boolean" ||
				!Array.isArray(result.findings) ||
				typeof result.summary !== "string"
			) {
				throw new Error("Malformed review response");
			}
			return {
				gateId: gate.id,
				trigger: gate.trigger.kind,
				outcome: result.pass ? GATE_OUTCOMES.pass : GATE_OUTCOMES.fail,
				reason: result.summary,
				evidence: result.findings,
				attemptNumber: context.attemptNumber,
				maxAttempts: gate.maxAttempts ?? 1,
			};
		} catch (error) {
			return {
				gateId: gate.id,
				trigger: gate.trigger.kind,
				outcome: GATE_OUTCOMES.fail,
				reason: error instanceof Error ? error.message : String(error),
				evidence: [],
				attemptNumber: context.attemptNumber,
				maxAttempts: gate.maxAttempts ?? 1,
			};
		}
	}
}

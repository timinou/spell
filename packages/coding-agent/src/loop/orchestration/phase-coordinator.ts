import type { HandoffArtifact, LoopRole } from "../contracts";
import { buildIterationPrompt, buildReflectionPrompt } from "../prompt-builder";
import type { LoopSnapshot } from "../types";
import { createHandoffArtifact } from "./handoff";

export interface LoopRoleResponse {
	summary: string;
	changedFiles?: string[];
	findings?: string[];
}

export interface LoopRoleResponder {
	run(role: LoopRole, prompt: string, loop: LoopSnapshot): Promise<LoopRoleResponse>;
}

export interface IterationRunResult {
	handoffs: HandoffArtifact[];
	changedFiles: string[];
	findings: string[];
	reviewSummary: string;
}

export class PhaseCoordinator {
	async runIteration(loop: LoopSnapshot, responder: LoopRoleResponder): Promise<IterationRunResult> {
		const planPrompt = buildIterationPrompt({
			loopId: loop.id,
			name: loop.name,
			iteration: loop.iteration,
			state: loop.state,
			summary: loop.lastSummary,
			taskContent: loop.taskContent,
			changedFiles: loop.changedFiles,
			openFindings: loop.openFindings,
			pendingGates: loop.pendingGates,
		});
		const plan = await responder.run("plan", planPrompt, loop);
		const planToCode = createHandoffArtifact({
			fromRole: "plan",
			toRole: "code",
			iteration: loop.iteration,
			summary: plan.summary,
		});
		const code = await responder.run("code", plan.summary, loop);
		const codeToReview = createHandoffArtifact({
			fromRole: "code",
			toRole: "review",
			iteration: loop.iteration,
			changedFiles: code.changedFiles,
			summary: code.summary,
		});
		const reviewPrompt = buildReflectionPrompt({
			loopId: loop.id,
			name: loop.name,
			iteration: loop.iteration,
			state: loop.state,
			summary: code.summary,
			taskContent: loop.taskContent,
			changedFiles: code.changedFiles ?? [],
			openFindings: code.findings ?? [],
			pendingGates: loop.pendingGates,
		});
		const review = await responder.run("review", reviewPrompt, loop);
		const reviewToPlan = createHandoffArtifact({
			fromRole: "review",
			toRole: "plan",
			iteration: loop.iteration,
			changedFiles: code.changedFiles,
			openFindings: review.findings,
			summary: review.summary,
		});
		return {
			handoffs: [planToCode, codeToReview, reviewToPlan],
			changedFiles: [...(code.changedFiles ?? [])],
			findings: [...(review.findings ?? [])],
			reviewSummary: review.summary,
		};
	}
}

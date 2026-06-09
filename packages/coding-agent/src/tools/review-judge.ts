/**
 * verify.review LLM-gating (PLAN-330b).
 *
 * A todo node's `verify.review` is acceptance criteria stated in prose. Unlike
 * cmd/artifact/commit gates — which the agent satisfies by doing work the tool
 * then detects — a review is *judged by a model*. On completion of a
 * review-bearing node we run a one-shot judge: it reads the criteria + a
 * compact slice of session context and returns pass / fail + reason.
 *
 * Design:
 * - single-phase: nothing manual for the agent to do, so no {verified:true}
 *   round-trip — the judge IS the verification.
 * - injectable: {@link ReviewJudge} is a function seam (mirrors the streamFn
 *   injection in the agent loop) so tests run deterministically with a stub and
 *   the tool never spins up a real model in unit tests.
 * - fail-open: an infra error (no model, network, parse) must never wedge a
 *   roster permanently — it resolves `pass` with a surfaced warning. A model
 *   that genuinely returns "fail" is honoured (fail-closed on a real verdict).
 * - no cycle: uses `streamSimple` (raw inference, no session/tools), not a
 *   task subagent — sidesteps the todo_write ↔ task scheduling cycle.
 */
import type { Api, Model } from "@spell/pi-ai";
import { streamSimple } from "@spell/pi-ai";
import { logger } from "@spell/pi-utils";

export interface ReviewJudgeRequest {
	/** Node id, for logging / message correlation. */
	nodeId: string;
	/** Human label of the node being judged. */
	content: string;
	/** The acceptance criteria (verify.review string). */
	criteria: string;
	/** Compact session context (recent work), may be empty. */
	context: string;
}

export interface ReviewJudgeVerdict {
	/** True when the criteria are judged satisfied. */
	pass: boolean;
	/** Short reason (one sentence). Present on fail; optional on pass. */
	reason: string;
	/** Set when the verdict is a fail-open fallback rather than a real judgement. */
	degraded?: boolean;
}

/** Injectable judge seam. Returns a verdict for one review-bearing node. */
export type ReviewJudge = (request: ReviewJudgeRequest) => Promise<ReviewJudgeVerdict>;

const JUDGE_SYSTEM = `You are a strict acceptance reviewer for a coding agent's task tracker.
Given a task's acceptance criteria and a compact slice of what the agent did, decide whether the criteria are objectively met.
Be conservative: if the evidence does not clearly show the criteria are satisfied, fail it.
Respond with ONE line of JSON only, no prose, no code fence:
{"pass": true|false, "reason": "<=20 words"}`;

function buildJudgePrompt(request: ReviewJudgeRequest): string {
	const ctx = request.context.trim();
	return [
		`TASK: ${request.content}`,
		`ACCEPTANCE CRITERIA: ${request.criteria}`,
		"",
		"EVIDENCE (recent session context):",
		ctx.length > 0 ? ctx : "(no context captured)",
		"",
		'Return only: {"pass": <bool>, "reason": "<reason>"}',
	].join("\n");
}

/** Parse the judge's single-line JSON verdict; tolerant of fences/whitespace. */
export function parseVerdict(raw: string): ReviewJudgeVerdict | undefined {
	const text = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) return undefined;
	try {
		const parsed = JSON.parse(match[0]) as { pass?: unknown; reason?: unknown };
		if (typeof parsed.pass !== "boolean") return undefined;
		return { pass: parsed.pass, reason: typeof parsed.reason === "string" ? parsed.reason : "" };
	} catch {
		return undefined;
	}
}

/**
 * Build the production judge from a resolved model. Fail-open on any error.
 * Returns undefined inputs → caller should fall back to no-gating (advisory).
 */
export function createModelReviewJudge(model: Model<Api>): ReviewJudge {
	return async request => {
		try {
			const stream = streamSimple(model, {
				systemPrompt: JUDGE_SYSTEM,
				messages: [{ role: "user", content: buildJudgePrompt(request), timestamp: Date.now() }],
			});
			let text = "";
			for await (const event of stream) {
				if (event.type === "text_delta") text += event.delta;
				else if (event.type === "text_end") text = event.partial.content.map(c => (c.type === "text" ? c.text : "")).join("");
				else if (event.type === "error")
					return { pass: true, reason: "review judge errored; advisory only", degraded: true };
			}
			const verdict = parseVerdict(text);
			if (!verdict) {
				logger.warn("review-judge: unparseable verdict, failing open", { nodeId: request.nodeId, text: text.slice(0, 200) });
				return { pass: true, reason: "review judge returned no verdict; advisory only", degraded: true };
			}
			return verdict;
		} catch (error) {
			logger.warn("review-judge: judge threw, failing open", { nodeId: request.nodeId, error });
			return { pass: true, reason: "review judge unavailable; advisory only", degraded: true };
		}
	};
}

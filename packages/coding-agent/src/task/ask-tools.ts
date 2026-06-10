/**
 * Interactive-task dialogue tools (PLAN-327).
 *
 * - `ask_orchestrator` — injected ONLY into a subagent's toolset (via
 *   ExecutorOptions.customTools) when `task.interactive` is on. Closed over the
 *   per-run AskBroker + the worker's task id. Blocking calls park on the broker
 *   promise (answer = tool result); non-blocking calls ack immediately and the
 *   answer is delivered to a later turn.
 *
 * - `answer_subtask` — used by the orchestrator-side answer pump. The pump forks
 *   a /btw-style stream over the parent context snapshot with `toolChoice` forced
 *   to this tool, so the orchestrator's reply is structured: an answer plus the
 *   recipient task ids. Never exposed to the root agent's normal toolset.
 */

import type { AgentTool } from "@spell/pi-agent-core";
import type { Component } from "@spell/pi-tui";
import { Text } from "@spell/pi-tui";
import { Type } from "@sinclair/typebox";
import type { Theme } from "../modes/theme/theme";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { AskBroker } from "./ask-broker";

// ─────────────────────────────────────────────────────────────────────────────
// ask_orchestrator (in-task)
// ─────────────────────────────────────────────────────────────────────────────

export const AskOrchestratorParams = Type.Object({
	question: Type.String({
		description: "The question for the orchestrator. Be specific; it answers from its own context.",
	}),
	blocking: Type.Boolean({
		description:
			"true = wait for the answer before continuing (you pause here). false = keep working; the answer arrives on a later turn.",
	}),
	scope_hint: Type.Optional(
		Type.String({
			description: "Optional: which sibling tasks you think also care. Advisory — the orchestrator decides.",
		}),
	),
	_i: Type.Optional(Type.String({ description: "Intent: 2-6 words, present participle." })),
});

interface AskOrchestratorDetails {
	question: string;
	blocking: boolean;
	answer?: string;
	cancelled?: boolean;
}

/**
 * Build the `ask_orchestrator` tool for a single subagent, closed over the
 * shared broker and the worker's task id.
 */
export function makeAskOrchestratorTool(
	broker: AskBroker,
	fromTaskId: string,
): CustomTool<typeof AskOrchestratorParams> {
	return {
		name: "ask_orchestrator",
		label: "Ask Orchestrator",
		description:
			"Ask the main orchestrator a question mid-task. Use when a decision is ambiguous and the orchestrator likely knows the intent. `blocking:true` waits for the answer (returned as this tool's result); `blocking:false` continues and the answer arrives later.",
		parameters: AskOrchestratorParams,
		hidden: true,
		async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
			const outcome = await broker.raise({
				fromTaskId,
				question: params.question,
				blocking: params.blocking,
				scopeHint: params.scope_hint,
			});

			if (outcome.cancelled) {
				const details: AskOrchestratorDetails = { question: params.question, blocking: params.blocking, cancelled: true };
				return {
					content: [
						{
							type: "text",
							text: `No answer available (${outcome.cancelReason ?? "cancelled"}). Proceed using your best judgment.`,
						},
					],
					details,
					data: details,
				};
			}

			if (params.blocking && outcome.answer !== undefined) {
				const details: AskOrchestratorDetails = { question: params.question, blocking: true, answer: outcome.answer };
				return {
					content: [{ type: "text", text: `Orchestrator: ${outcome.answer}` }],
					details,
					data: details,
				};
			}

			// Non-blocking: acknowledged; answer will arrive on a later turn.
			const details: AskOrchestratorDetails = { question: params.question, blocking: false };
			return {
				content: [
					{
						type: "text",
						text: "Question sent to the orchestrator. Keep working; the answer will arrive on a later turn.",
					},
				],
				details,
				data: details,
			};
		},

		renderCall(args, _options, theme): Component {
			const mode = args.blocking ? "blocking" : "async";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("ask_orchestrator "))}${theme.fg("muted", `[${mode}] `)}${theme.fg(
					"dim",
					String(args.question).slice(0, 80),
				)}`,
				0,
				0,
			);
		},

		renderResult(result, _options, theme): Component {
			const details = result.details as AskOrchestratorDetails | undefined;
			if (details?.cancelled) {
				return new Text(`${theme.fg("warning", theme.status.warning)} ${theme.fg("dim", "no answer")}`, 0, 0);
			}
			if (details?.answer) {
				return new Text(
					`${theme.fg("success", theme.status.success)} ${theme.fg("dim", details.answer.slice(0, 80))}`,
					0,
					0,
				);
			}
			return new Text(`${theme.fg("accent", "→")} ${theme.fg("dim", "sent (async)")}`, 0, 0);
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// answer_subtask (orchestrator-side, used inside the answer pump's forced stream)
// ─────────────────────────────────────────────────────────────────────────────

export const AnswerSubtaskParams = Type.Object({
	answer: Type.String({
		description: "Your answer to the subtask's question. Terse and directive.",
	}),
	recipients: Type.Array(Type.String(), {
		description:
			"Task ids that should also receive this answer (the asking task always receives it). Include a sibling id when the answer affects its work too.",
	}),
	_i: Type.Optional(Type.String({ description: "Intent: 2-6 words, present participle." })),
});

export interface AnswerSubtaskDetails {
	answer: string;
	recipients: string[];
}

/**
 * The `answer_subtask` tool. Returned by the answer pump's forced-toolChoice
 * stream; its handler resolves the broker. Not registered on the root agent's
 * normal toolset — only materialized inside the pump.
 */
export const answerSubtaskTool: AgentTool<typeof AnswerSubtaskParams, AnswerSubtaskDetails, Theme> = {
	name: "answer_subtask",
	label: "Answer Subtask",
	description:
		"Answer a subtask's question. The asking task always receives the answer; add recipient task ids for any sibling tasks the answer also affects.",
	parameters: AnswerSubtaskParams,
	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		const recipients = Array.isArray(params.recipients) ? params.recipients : [];
		return {
			content: [{ type: "text", text: `Answer routed to: ${recipients.join(", ") || "(originator only)"}` }],
			details: { answer: params.answer, recipients },
			data: { answer: params.answer, recipients },
		};
	},
};

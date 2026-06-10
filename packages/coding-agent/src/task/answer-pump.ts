/**
 * Orchestrator-side answer pump for interactive tasks (PLAN-327).
 *
 * When a subagent raises a question, the pump answers it the way `/btw` does:
 * it forks a one-shot `streamSimple` over a SNAPSHOT of the orchestrator's
 * context (system prompt + compact conversation), with `toolChoice` forced to
 * `answer_subtask`. This never takes a live orchestrator turn, so the
 * orchestrator can be blocked in `await taskBatch` and still answer — no async
 * dependency, no deadlock (D3).
 *
 * The pump wires itself to the broker: `subscribeRaised` → fork+answer →
 * `broker.answer(...)`. Recipient delivery (followUp + the D6 main-history note)
 * is handled by the caller via `broker.setDeliver` and `onAnswered`.
 */

import type { AgentMessage } from "@spell/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	type Message,
	type Model,
	type SimpleStreamOptions,
	streamSimple,
	type ToolCall,
} from "@spell/pi-ai";
import { logger } from "@spell/pi-utils";
import type { Static } from "@sinclair/typebox";
import type { ModelRegistry } from "../config/model-registry";
import type { AskBroker, AskQuestion } from "./ask-broker";
import { AnswerSubtaskParams, answerSubtaskTool } from "./ask-tools";

/**
 * Minimal session surface the pump forks over (structurally satisfied by
 * AgentSession). Kept as `unknown`-ish at the edges so the concrete session
 * assigns without coupling the pump to the full AgentSession type.
 */
export interface AnswerPumpSession {
	readonly model: Model | undefined;
	readonly sessionId: string;
	readonly systemPrompt: string;
	readonly modelRegistry: Pick<ModelRegistry, "getApiKey">;
	convertMessagesToLlm(messages: AgentMessage[], signal?: AbortSignal): Promise<Message[]>;
	prepareSimpleStreamOptions(options: SimpleStreamOptions): SimpleStreamOptions;
	/** Compact conversation snapshot (excludes tool results / system prompt). */
	formatCompactContext(): string;
}

export interface AnswerPumpResult {
	answer: string;
	recipients: string[];
}

/** Frame the subtask question for the forced-answer stream. */
function buildQuestionFrame(question: AskQuestion): string {
	const lines = [
		"<subtask-question>",
		`A subtask you dispatched (task id: ${question.fromTaskId}) is asking you a question.`,
		"Answer it directly from your context, then call answer_subtask.",
		"The asking task always receives your answer; add other task ids to `recipients` only if the answer also affects their work.",
	];
	if (question.scopeHint) {
		lines.push(`The subtask thinks these siblings may also care: ${question.scopeHint} (your call).`);
	}
	lines.push("", `Question: ${question.question}`, "</subtask-question>");
	return lines.join("\n");
}

/** Extract the answer_subtask tool call from a finished assistant message. */
function extractAnswer(message: AssistantMessage): AnswerPumpResult | undefined {
	const toolCall = message.content.find(
		(block): block is ToolCall => block.type === "toolCall" && block.name === answerSubtaskTool.name,
	);
	if (!toolCall) return undefined;
	const args = toolCall.arguments as Partial<Static<typeof AnswerSubtaskParams>>;
	const answer = typeof args.answer === "string" ? args.answer : undefined;
	if (answer === undefined) return undefined;
	const recipients = Array.isArray(args.recipients) ? args.recipients.filter(r => typeof r === "string") : [];
	return { answer, recipients };
}

/**
 * Run the forced-answer fork for a single question. Returns the parsed answer
 * or undefined if the model failed to produce a usable answer_subtask call.
 */
export async function runAnswerFork(
	session: AnswerPumpSession,
	question: AskQuestion,
	options?: { signal?: AbortSignal; streamFn?: typeof streamSimple },
): Promise<AnswerPumpResult | undefined> {
	const model = session.model;
	if (!model) {
		logger.warn("answer-pump: no active model; cannot answer subtask question", {
			questionId: question.questionId,
		});
		return undefined;
	}
	const streamFn = options?.streamFn ?? streamSimple;
	const apiKey = await session.modelRegistry.getApiKey(model, session.sessionId);
	if (!apiKey) {
		logger.warn("answer-pump: no API key for model provider", { provider: model.provider });
		return undefined;
	}

	const snapshot = session.formatCompactContext();
	const snapshotMessage: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: snapshot }],
		attribution: "agent",
		timestamp: Date.now(),
	};
	const questionMessage: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: buildQuestionFrame(question) }],
		attribution: "agent",
		timestamp: Date.now(),
	};
	const llmMessages = await session.convertMessagesToLlm([snapshotMessage, questionMessage], options?.signal);

	const context: Context = {
		systemPrompt: session.systemPrompt,
		messages: llmMessages,
		tools: [
			{
				name: answerSubtaskTool.name,
				description: answerSubtaskTool.description,
				parameters: answerSubtaskTool.parameters,
			},
		],
	};
	const streamOptions = session.prepareSimpleStreamOptions({
		apiKey,
		sessionId: session.sessionId,
		signal: options?.signal,
		toolChoice: { type: "tool", name: answerSubtaskTool.name },
	});

	try {
		const stream = streamFn(model, context, streamOptions);
		for await (const event of stream) {
			if (event.type === "done") {
				return extractAnswer(event.message);
			}
			if (event.type === "error") {
				logger.warn("answer-pump: stream error answering subtask", {
					questionId: question.questionId,
					error: event.error?.errorMessage,
				});
				return undefined;
			}
		}
	} catch (err) {
		logger.error("answer-pump: fork threw", { questionId: question.questionId, error: String(err) });
		return undefined;
	}
	return undefined;
}

/**
 * Wire the pump to a broker: on every raised question, fork an answer and route
 * it back through `broker.answer`. `onAnswered` lets the caller record the D6
 * main-history note. When the fork fails, the question is cancelled so blocking
 * workers unpark with a "decide yourself" outcome.
 */
export function attachAnswerPump(
	broker: AskBroker,
	session: AnswerPumpSession,
	hooks?: {
		onAnswered?: (question: AskQuestion, result: AnswerPumpResult) => void;
		signal?: AbortSignal;
		streamFn?: typeof streamSimple;
	},
): void {
	broker.subscribeRaised(question => {
		void (async () => {
			try {
				const result = await runAnswerFork(session, question, {
					signal: hooks?.signal,
					streamFn: hooks?.streamFn,
				});
				if (!result) {
					// No usable answer: cancel so blocking workers proceed on their own judgment.
					broker.answer(question.questionId, "", [question.fromTaskId]);
					return;
				}
				broker.answer(question.questionId, result.answer, result.recipients);
				hooks?.onAnswered?.(question, result);
			} catch (err) {
				// Any rejection in fork setup (getApiKey/transform/stream) MUST still unpark a
				// blocking worker — otherwise its runner never completes and the batch deadlocks.
				logger.error("answer-pump: fork rejected; unparking worker", {
					questionId: question.questionId,
					error: String(err),
				});
				broker.answer(question.questionId, "", [question.fromTaskId]);
			}
		})();
	});
}

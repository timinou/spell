/**
 * AskBroker — worker↔orchestrator dialogue channel for interactive tasks (PLAN-327).
 *
 * In-process subagents share the parent Bun process, so the broker is a plain
 * shared object — no IPC. It is the *functional* channel: blocking asks park on
 * a Promise the broker resolves. The `task:ask:*` EventBus emits are
 * observation-only (TUI / spell-server).
 *
 * Lifecycle: one broker per `task` batch, owned by TaskTool. Threaded to each
 * child via an injected `ask_orchestrator` tool closed over `raise`, and to the
 * orchestrator-side answer pump via `subscribeRaised` + `answer`.
 *
 * Wait modes (D1):
 * - blocking  → `raise` resolves when the matching answer arrives (worker parks
 *   at the tool-call boundary; answer becomes the tool result).
 * - non-block → `raise` resolves immediately with an ack; the answer is later
 *   delivered out-of-band (the pump calls the deliver callback → session
 *   `followUp`). The worker drains it on its next turn.
 *
 * Invariants enforced in code (NOT prompt): the originator always receives the
 * answer (D2); answering an unknown/duplicate questionId is a no-op.
 */

import { logger } from "@spell/pi-utils";
import type { EventBus } from "../utils/event-bus";

/** A question raised by a subagent. */
export interface AskQuestion {
	runId: string;
	questionId: string;
	fromTaskId: string;
	fromSessionId?: string;
	question: string;
	scopeHint?: string;
	blocking: boolean;
	raisedAtMs: number;
}

/** An answer composed by the orchestrator. */
export interface AskAnswer {
	questionId: string;
	answer: string;
	/** Task ids that receive the answer (originator always included). */
	recipients: string[];
	answeredAtMs: number;
}

/** Outcome handed back to a blocking `raise` caller. */
export interface AskOutcome {
	questionId: string;
	/** Present when an answer arrived; undefined when cancelled. */
	answer?: string;
	cancelled?: boolean;
	cancelReason?: string;
}

/** Per-task delivery fn: injects an answer into that task's running session (followUp). */
export type AskDeliverFn = (text: string) => void;

/** Listener invoked when a question is raised (the orchestrator answer pump). */
export type AskRaisedListener = (question: AskQuestion) => void;

interface PendingAsk {
	question: AskQuestion;
	/** Resolver for a blocking raise; undefined for non-blocking asks. */
	resolve?: (outcome: AskOutcome) => void;
}

let questionCounter = 0;

function nextQuestionId(runId: string): string {
	questionCounter += 1;
	return `${runId}:ask-${questionCounter}`;
}

export class AskBroker {
	readonly #runId: string;
	readonly #eventBus?: EventBus;
	readonly #pending = new Map<string, PendingAsk>();
	/** Maps a task id → its session id, for routing + observation. */
	readonly #taskSessions = new Map<string, string>();
	/** Per-task delivery fns, registered by the executor once a child session exists. */
	readonly #delivery = new Map<string, AskDeliverFn>();
	/** Answered asks, accumulated for surfacing in the task result (D6, turn-safe). */
	readonly #answered: AskAnswer[] = [];
	/** questionId → question text, for the answered-log summary. */
	readonly #questionText = new Map<string, string>();
	#raisedListener?: AskRaisedListener;
	#closed = false;

	constructor(runId: string, eventBus?: EventBus) {
		this.#runId = runId;
		this.#eventBus = eventBus;
	}

	get runId(): string {
		return this.#runId;
	}

	/** Register the session id backing a task id (for routing / observation). */
	registerTaskSession(taskId: string, sessionId: string): void {
		this.#taskSessions.set(taskId, sessionId);
	}

	/**
	 * Register how to deliver an out-of-band answer to a task's running session.
	 * Called by the executor once the child session exists. Delivery is a
	 * followUp into that session, surfacing on the worker's next turn.
	 */
	registerDelivery(taskId: string, deliver: AskDeliverFn): void {
		this.#delivery.set(taskId, deliver);
	}

	/** Drop a task's delivery fn (session finished). */
	unregisterDelivery(taskId: string): void {
		this.#delivery.delete(taskId);
	}

	/** Subscribe the orchestrator answer pump. Only one listener is supported. */
	subscribeRaised(listener: AskRaisedListener): void {
		this.#raisedListener = listener;
	}

	/**
	 * Raise a question from a subagent. For blocking asks the returned Promise
	 * resolves when the orchestrator answers (or the broker is closed). For
	 * non-blocking asks it resolves immediately with just the questionId.
	 */
	raise(input: {
		fromTaskId: string;
		question: string;
		blocking: boolean;
		scopeHint?: string;
		fromSessionId?: string;
	}): Promise<AskOutcome> {
		if (this.#closed) {
			return Promise.resolve({ questionId: "", cancelled: true, cancelReason: "broker closed" });
		}
		const questionId = nextQuestionId(this.#runId);
		const question: AskQuestion = {
			runId: this.#runId,
			questionId,
			fromTaskId: input.fromTaskId,
			fromSessionId: input.fromSessionId ?? this.#taskSessions.get(input.fromTaskId),
			question: input.question,
			scopeHint: input.scopeHint,
			blocking: input.blocking,
			raisedAtMs: Date.now(),
		};

		this.#eventBus?.emit("task:ask:raised", {
			runId: question.runId,
			questionId: question.questionId,
			fromTaskId: question.fromTaskId,
			fromSessionId: question.fromSessionId,
			question: question.question,
			scopeHint: question.scopeHint,
			blocking: question.blocking,
		});

		this.#questionText.set(questionId, question.question);
		if (!input.blocking) {
			this.#pending.set(questionId, { question });
			this.#notifyRaised(question);
			return Promise.resolve({ questionId });
		}

		return new Promise<AskOutcome>(resolve => {
			this.#pending.set(questionId, { question, resolve });
			this.#notifyRaised(question);
		});
	}

	/**
	 * Answer a raised question. Routes to all recipients (originator always
	 * included). Resolves the originator's parked promise (blocking) and
	 * delivers to every other recipient via the deliver callback.
	 */
	answer(questionId: string, answer: string, recipients: string[]): AskAnswer | undefined {
		const pending = this.#pending.get(questionId);
		if (!pending) {
			logger.warn("AskBroker.answer: unknown or already-answered questionId", { questionId });
			return undefined;
		}
		this.#pending.delete(questionId);

		// D2 invariant: originator always receives, enforced here (not prompt).
		const recipientSet = new Set(recipients);
		recipientSet.add(pending.question.fromTaskId);
		const finalRecipients = [...recipientSet];

		const resolved: AskAnswer = {
			questionId,
			answer,
			recipients: finalRecipients,
			answeredAtMs: Date.now(),
		};

		this.#answered.push(resolved);
		this.#eventBus?.emit("task:ask:answered", {
			runId: this.#runId,
			questionId,
			answer,
			recipients: finalRecipients,
		});

		// Originator: resolve the parked blocking promise (answer = tool result).
		// Non-blocking originator + every other recipient: deliver out-of-band.
		const originator = pending.question.fromTaskId;
		const deliveryText = this.#formatDelivery(pending.question, answer);
		if (pending.resolve) {
			pending.resolve({ questionId, answer });
		} else {
			this.#delivery.get(originator)?.(deliveryText);
		}
		for (const taskId of finalRecipients) {
			if (taskId === originator) continue;
			this.#delivery.get(taskId)?.(deliveryText);
		}

		return resolved;
	}

	/** True when a question is still awaiting an answer. */
	hasPending(questionId: string): boolean {
		return this.#pending.has(questionId);
	}

	/** Number of questions still awaiting an answer. */
	pendingCount(): number {
		return this.#pending.size;
	}

	/**
	 * All answers composed during this run. Surfaced in the task result so the
	 * orchestrator stays aware of what it told workers WITHOUT a mid-turn history
	 * mutation (which would corrupt tool_use/tool_result pairing). Pairs each
	 * answer with the originating question text for a readable summary.
	 */
	answeredLog(): Array<{ question: string; answer: string; recipients: string[] }> {
		return this.#answered
			.filter(a => a.answer.trim().length > 0)
			.map(a => ({
				question: this.#questionText.get(a.questionId) ?? "",
				answer: a.answer,
				recipients: a.recipients,
			}));
	}

	/**
	 * Cancel all outstanding asks (e.g. batch finished / aborted). Blocking
	 * callers resolve with `cancelled: true` so workers unpark cleanly.
	 */
	close(reason = "batch complete"): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const [questionId, pending] of this.#pending) {
			this.#eventBus?.emit("task:ask:cancelled", { runId: this.#runId, questionId, reason });
			pending.resolve?.({ questionId, cancelled: true, cancelReason: reason });
		}
		this.#pending.clear();
	}

	#formatDelivery(question: AskQuestion, answer: string): string {
		return [
			"<orchestrator-answer>",
			`Re: "${question.question}"`,
			answer,
			"</orchestrator-answer>",
		].join("\n");
	}

	#notifyRaised(question: AskQuestion): void {
		if (!this.#raisedListener) {
			logger.warn("AskBroker: question raised with no answer pump subscribed", {
				questionId: question.questionId,
			});
			return;
		}
		try {
			this.#raisedListener(question);
		} catch (err) {
			logger.error("AskBroker raised-listener error", { error: String(err) });
		}
	}
}

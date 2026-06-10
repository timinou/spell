/**
 * answer-pump tests (PLAN-327): the /btw-style fork forces answer_subtask,
 * extracts {answer, recipients}, and routes through the broker. Uses a stub
 * stream so no provider/model is needed.
 */
import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@spell/pi-ai";
import { AskBroker, type AskQuestion } from "../../src/task/ask-broker";
import { type AnswerPumpSession, attachAnswerPump, runAnswerFork } from "../../src/task/answer-pump";

function makeStubSession(): AnswerPumpSession {
	return {
		model: { provider: "anthropic" } as never,
		sessionId: "sess-1",
		systemPrompt: "sys",
		modelRegistry: { getApiKey: async () => "key" } as never,
		convertMessagesToLlm: async () => [],
		prepareSimpleStreamOptions: opts => opts,
		formatCompactContext: () => "compact-history",
	};
}

/** A stub stream that yields a single `done` event with an answer_subtask call. */
function stubStreamWithAnswer(answer: string, recipients: string[]) {
	const message: AssistantMessage = {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "tc-1",
				name: "answer_subtask",
				arguments: { answer, recipients },
			},
		],
		stopReason: "toolUse",
	} as unknown as AssistantMessage;
	return (async function* () {
		yield { type: "done", message } as never;
	})();
}

function stubStreamNoToolCall() {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "I cannot answer" }],
		stopReason: "stop",
	} as unknown as AssistantMessage;
	return (async function* () {
		yield { type: "done", message } as never;
	})();
}

describe("runAnswerFork", () => {
	test("extracts answer + recipients from forced answer_subtask call", async () => {
		const session = makeStubSession();
		const question: AskQuestion = {
			runId: "r",
			questionId: "r:ask-1",
			fromTaskId: "t1",
			question: "which?",
			blocking: true,
			raisedAtMs: Date.now(),
		};
		const result = await runAnswerFork(session, question, {
			streamFn: (() => stubStreamWithAnswer("use AppError", ["t2"])) as never,
		});
		expect(result?.answer).toBe("use AppError");
		expect(result?.recipients).toEqual(["t2"]);
	});

	test("returns undefined when the model emits no answer_subtask call", async () => {
		const session = makeStubSession();
		const question: AskQuestion = {
			runId: "r",
			questionId: "r:ask-1",
			fromTaskId: "t1",
			question: "which?",
			blocking: true,
			raisedAtMs: Date.now(),
		};
		const result = await runAnswerFork(session, question, {
			streamFn: (() => stubStreamNoToolCall()) as never,
		});
		expect(result).toBeUndefined();
	});
});

describe("attachAnswerPump", () => {
	test("answers a raised blocking question end-to-end", async () => {
		const broker = new AskBroker("r");
		const session = makeStubSession();
		attachAnswerPump(broker, session, {
			streamFn: (() => stubStreamWithAnswer("answer!", [])) as never,
		});
		const outcome = await broker.raise({ fromTaskId: "t1", question: "q", blocking: true });
		expect(outcome.answer).toBe("answer!");
	});

	test("failed fork cancels the question (worker proceeds)", async () => {
		const broker = new AskBroker("r");
		const session = makeStubSession();
		const d1: string[] = [];
		broker.registerDelivery("t1", t => d1.push(t));
		attachAnswerPump(broker, session, {
			streamFn: (() => stubStreamNoToolCall()) as never,
		});
		const outcome = await broker.raise({ fromTaskId: "t1", question: "q", blocking: true });
		// answer("") with originator-only recipients resolves the blocking promise with empty answer.
		expect(outcome.answer).toBe("");
	});

	test("fork REJECTION still unparks the blocking worker (no deadlock)", async () => {
		const broker = new AskBroker("r");
		const session = makeStubSession();
		attachAnswerPump(broker, session, {
			streamFn: (() => {
				throw new Error("provider exploded");
			}) as never,
		});
		const outcome = await broker.raise({ fromTaskId: "t1", question: "q", blocking: true });
		// Rejection path resolves the parked promise with empty answer rather than hanging.
		expect(outcome.answer).toBe("");
	});

	test("answeredLog records answered questions for turn-safe D6 surfacing", async () => {
		const broker = new AskBroker("r");
		const session = makeStubSession();
		attachAnswerPump(broker, session, {
			streamFn: (() => stubStreamWithAnswer("the answer", ["t2"])) as never,
		});
		await broker.raise({ fromTaskId: "t1", question: "the question", blocking: true });
		await new Promise(r => setTimeout(r, 0));
		const log = broker.answeredLog();
		expect(log.length).toBe(1);
		expect(log[0]?.question).toBe("the question");
		expect(log[0]?.answer).toBe("the answer");
		expect(log[0]?.recipients).toContain("t1");
		expect(log[0]?.recipients).toContain("t2");
	});

	test("onAnswered hook fires with the resolved answer + recipients", async () => {
		const broker = new AskBroker("r");
		const session = makeStubSession();
		const seen: Array<{ q: string; a: string; recipients: string[] }> = [];
		attachAnswerPump(broker, session, {
			streamFn: (() => stubStreamWithAnswer("ok", ["t2"])) as never,
			onAnswered: (q, res) => seen.push({ q: q.question, a: res.answer, recipients: res.recipients }),
		});
		await broker.raise({ fromTaskId: "t1", question: "shared?", blocking: true });
		// allow the async pump microtask to flush
		await new Promise(r => setTimeout(r, 0));
		expect(seen.length).toBe(1);
		expect(seen[0]?.a).toBe("ok");
	});
});

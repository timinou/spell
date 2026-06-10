/**
 * Interactive task end-to-end test-drive (PLAN-327).
 *
 * Exercises the full worker↔orchestrator loop deterministically WITHOUT a live
 * model: a stub answer-pump session stands in for the orchestrator's /btw-style
 * fork, fake worker sessions stand in for in-process subagents. Proves:
 *  - blocking ask parks the worker and resolves with the answer (= tool result)
 *  - the orchestrator fans the answer to a SUBSET of sibling tasks (your
 *    /btw-broadcast scenario): originator + chosen recipients, others untouched
 *  - the executor-style isStreaming delivery guard (wave-2 P1 fix) holds:
 *    an idle/finished worker is NOT revived by a late answer
 *  - answeredLog() surfaces the dialogue for the turn-safe D6 result summary
 */
import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@spell/pi-ai";
import { AskBroker } from "../../src/task/ask-broker";
import { type AnswerPumpSession, attachAnswerPump } from "../../src/task/answer-pump";
import { makeAskOrchestratorTool } from "../../src/task/ask-tools";

/** Orchestrator stub session the real pump forks over. */
function makeOrchestrator(): AnswerPumpSession {
	return {
		model: { provider: "anthropic" } as never,
		sessionId: "orchestrator",
		systemPrompt: "you are the orchestrator",
		modelRegistry: { getApiKey: async () => "key" } as never,
		convertMessagesToLlm: async () => [],
		prepareSimpleStreamOptions: opts => opts,
		formatCompactContext: () => "orchestrator context snapshot",
	};
}

/** A forked-stream stub yielding a single answer_subtask call (the orchestrator's reply). */
function answerStream(answer: string, recipients: string[]) {
	const message = {
		role: "assistant",
		content: [{ type: "toolCall", id: "tc", name: "answer_subtask", arguments: { answer, recipients } }],
		stopReason: "toolUse",
	} as unknown as AssistantMessage;
	return (async function* () {
		yield { type: "done", message } as never;
	})();
}

/** Fake in-process worker: records delivered followUps, models isStreaming. */
class FakeWorker {
	delivered: string[] = [];
	streaming = true;
	constructor(
		readonly taskId: string,
		readonly broker: AskBroker,
	) {
		// Mirror executor wiring: register a guarded delivery into this worker.
		broker.registerDelivery(taskId, text => {
			if (!this.streaming) return; // wave-2 isStreaming guard
			this.delivered.push(text);
		});
	}

	finish(): void {
		this.streaming = false;
	}
}

describe("interactive task end-to-end", () => {
	test("blocking ask → orchestrator fans answer to a subset (the /btw-broadcast scenario)", async () => {
		const broker = new AskBroker("run-e2e");
		const orchestrator = makeOrchestrator();
		// Drive the REAL answer pump. The orchestrator judges the answer relevant to
		// task-1 (originator) and task-3 — its forked reply names task-3 as a recipient.
		attachAnswerPump(broker, orchestrator, {
			streamFn: (() => answerStream("use AppError", ["task-3"])) as never,
		});

		const w1 = new FakeWorker("task-1", broker);
		const w2 = new FakeWorker("task-2", broker);
		const w3 = new FakeWorker("task-3", broker);

		// task-1 asks via its injected tool (blocking).
		const tool = makeAskOrchestratorTool(broker, "task-1");
		const result = await tool.execute("tc-1", { question: "which error type?", blocking: true }, undefined, {} as never);

		// Originator got the answer as the tool result (parked promise resolved).
		const text = result.content.filter(c => c.type === "text").map(c => (c as { text: string }).text).join("");
		expect(text).toContain("use AppError");

		// Fan-out: task-3 received it out-of-band; task-2 did NOT (not a recipient);
		// task-1 is the originator (parked promise, no out-of-band delivery).
		expect(w3.delivered.length).toBe(1);
		expect(w3.delivered[0]).toContain("use AppError");
		expect(w2.delivered).toEqual([]);
		expect(w1.delivered).toEqual([]);

		// D6: dialogue surfaced for the turn-safe result summary.
		const log = broker.answeredLog();
		expect(log.length).toBe(1);
		expect(log[0]?.recipients).toContain("task-1");
		expect(log[0]?.recipients).toContain("task-3");
	});

	test("isStreaming guard: a finished worker is NOT revived by a late answer", async () => {
		const broker = new AskBroker("run-guard");
		broker.subscribeRaised(q => {
			// Answer names the finished worker task-2 as a recipient.
			queueMicrotask(() => broker.answer(q.questionId, "late info", ["task-2"]));
		});
		const w2 = new FakeWorker("task-2", broker);
		w2.finish(); // worker completed before the answer arrives

		const tool = makeAskOrchestratorTool(broker, "task-1");
		new FakeWorker("task-1", broker);
		await tool.execute("tc", { question: "q", blocking: true }, undefined, {} as never);
		await new Promise(r => setTimeout(r, 0));

		// Guard held: the finished worker received nothing (would otherwise revive it).
		expect(w2.delivered).toEqual([]);
	});

	test("non-blocking ask: worker continues, answer delivered out-of-band later", async () => {
		const broker = new AskBroker("run-nb");
		let raisedBlocking: boolean | undefined;
		broker.subscribeRaised(q => {
			raisedBlocking = q.blocking;
			queueMicrotask(() => broker.answer(q.questionId, "deferred", []));
		});
		const w1 = new FakeWorker("task-1", broker);

		const tool = makeAskOrchestratorTool(broker, "task-1");
		const result = await tool.execute("tc", { question: "later?", blocking: false }, undefined, {} as never);
		const text = result.content.filter(c => c.type === "text").map(c => (c as { text: string }).text).join("");

		expect(raisedBlocking).toBe(false);
		expect(text).toContain("Keep working");
		await new Promise(r => setTimeout(r, 0));
		// Non-blocking originator receives the answer via out-of-band delivery.
		expect(w1.delivered.length).toBe(1);
		expect(w1.delivered[0]).toContain("deferred");
	});

	test("batch close unparks a worker still awaiting an answer (no deadlock)", async () => {
		const broker = new AskBroker("run-close");
		// No pump attached → nobody answers; simulate batch finishing.
		new FakeWorker("task-1", broker);
		const tool = makeAskOrchestratorTool(broker, "task-1");
		const p = tool.execute("tc", { question: "q", blocking: true }, undefined, {} as never);
		// Batch completes while the ask is still pending.
		queueMicrotask(() => broker.close("batch complete"));
		const result = await p;
		const text = result.content.filter(c => c.type === "text").map(c => (c as { text: string }).text).join("");
		expect(text).toContain("best judgment");
	});
});

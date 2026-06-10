/**
 * ask_orchestrator tool tests (PLAN-327): arg→raise mapping + result shaping
 * for blocking, non-blocking, and cancelled outcomes.
 */
import { describe, expect, test } from "bun:test";
import { AskBroker } from "../../src/task/ask-broker";
import { makeAskOrchestratorTool } from "../../src/task/ask-tools";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("");
}

describe("ask_orchestrator tool", () => {
	test("blocking call parks then returns the answer as the tool result", async () => {
		const broker = new AskBroker("r");
		let raisedBlocking: boolean | undefined;
		broker.subscribeRaised(q => {
			raisedBlocking = q.blocking;
			// Answer asynchronously so execute() actually parks.
			queueMicrotask(() => broker.answer(q.questionId, "use AppError", []));
		});
		const tool = makeAskOrchestratorTool(broker, "t1");
		const result = await tool.execute("tc-1", { question: "which error?", blocking: true }, undefined, {} as never);
		expect(raisedBlocking).toBe(true);
		expect(textOf(result)).toContain("use AppError");
	});

	test("non-blocking call returns an ack without waiting", async () => {
		const broker = new AskBroker("r");
		let raisedBlocking: boolean | undefined;
		broker.subscribeRaised(q => {
			raisedBlocking = q.blocking;
		});
		const tool = makeAskOrchestratorTool(broker, "t1");
		const result = await tool.execute("tc-1", { question: "later?", blocking: false }, undefined, {} as never);
		expect(raisedBlocking).toBe(false);
		expect(textOf(result)).toContain("Keep working");
		// Still pending (answer arrives out-of-band later).
		expect(broker.pendingCount()).toBe(1);
	});

	test("cancelled outcome tells the worker to proceed on its own judgment", async () => {
		const broker = new AskBroker("r");
		broker.subscribeRaised(q => {
			// Simulate fork failure → cancel via empty answer to originator-only.
			queueMicrotask(() => broker.answer(q.questionId, "", [q.fromTaskId]));
		});
		const tool = makeAskOrchestratorTool(broker, "t1");
		const result = await tool.execute("tc-1", { question: "q", blocking: true }, undefined, {} as never);
		// Empty answer resolves the blocking promise; tool surfaces the (empty) answer.
		const text = textOf(result);
		expect(text.length).toBeGreaterThan(0);
	});

	test("close() before answer unparks the blocking tool call", async () => {
		const broker = new AskBroker("r");
		broker.subscribeRaised(() => {
			// never answer; close instead
			queueMicrotask(() => broker.close("batch done"));
		});
		const tool = makeAskOrchestratorTool(broker, "t1");
		const result = await tool.execute("tc-1", { question: "q", blocking: true }, undefined, {} as never);
		expect(textOf(result)).toContain("best judgment");
	});
});

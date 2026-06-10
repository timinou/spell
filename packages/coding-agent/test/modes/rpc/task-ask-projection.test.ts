/**
 * task-ask-projection unit tests (PLAN-331 W3').
 *
 * The projection maps in-process `task:ask:*` EventBus emits onto RPC stdout
 * `task_ask` frames so spell-server can observe the dialogue. Observation-only:
 * the mapping is a pure transform; no answer path is exercised.
 */
import { describe, expect, test } from "bun:test";
import type { RpcTaskAskEvent } from "../../../src/modes/rpc/rpc-types";
import { projectTaskAskEvents, type TaskAskSink } from "../../../src/modes/rpc/task-ask-projection";
import { EventBus } from "../../../src/utils/event-bus";

function collect(): { sink: TaskAskSink; frames: RpcTaskAskEvent[] } {
	const frames: RpcTaskAskEvent[] = [];
	return { sink: e => frames.push(e), frames };
}

describe("projectTaskAskEvents", () => {
	test("raised → task_ask/raised frame with all fields", () => {
		const bus = new EventBus();
		const { sink, frames } = collect();
		projectTaskAskEvents(bus, sink);

		bus.emit("task:ask:raised", {
			runId: "run-1",
			questionId: "run-1:ask-1",
			fromTaskId: "task-a",
			fromSessionId: "sess-9",
			question: "Which config?",
			scopeHint: "deploy",
			blocking: true,
		});

		expect(frames).toEqual([
			{
				type: "task_ask",
				phase: "raised",
				runId: "run-1",
				questionId: "run-1:ask-1",
				fromTaskId: "task-a",
				fromSessionId: "sess-9",
				question: "Which config?",
				scopeHint: "deploy",
				blocking: true,
			},
		]);
	});

	test("answered → task_ask/answered frame", () => {
		const bus = new EventBus();
		const { sink, frames } = collect();
		projectTaskAskEvents(bus, sink);

		bus.emit("task:ask:answered", {
			runId: "run-1",
			questionId: "run-1:ask-1",
			answer: "the prod one",
			recipients: ["task-a", "task-b"],
		});

		expect(frames).toEqual([
			{
				type: "task_ask",
				phase: "answered",
				runId: "run-1",
				questionId: "run-1:ask-1",
				answer: "the prod one",
				recipients: ["task-a", "task-b"],
			},
		]);
	});

	test("cancelled → task_ask/cancelled frame", () => {
		const bus = new EventBus();
		const { sink, frames } = collect();
		projectTaskAskEvents(bus, sink);

		bus.emit("task:ask:cancelled", { runId: "run-1", questionId: "run-1:ask-2", reason: "batch complete" });

		expect(frames).toEqual([
			{ type: "task_ask", phase: "cancelled", runId: "run-1", questionId: "run-1:ask-2", reason: "batch complete" },
		]);
	});

	test("a full raised→answered dialogue projects two ordered frames", () => {
		const bus = new EventBus();
		const { sink, frames } = collect();
		projectTaskAskEvents(bus, sink);

		bus.emit("task:ask:raised", {
			runId: "r",
			questionId: "r:ask-1",
			fromTaskId: "t",
			question: "Q?",
			blocking: false,
		});
		bus.emit("task:ask:answered", { runId: "r", questionId: "r:ask-1", answer: "A", recipients: ["t"] });

		expect(frames.map(f => f.phase)).toEqual(["raised", "answered"]);
	});

	test("unsubscribe detaches all three channels", () => {
		const bus = new EventBus();
		const { sink, frames } = collect();
		const unsub = projectTaskAskEvents(bus, sink);
		unsub();

		bus.emit("task:ask:raised", {
			runId: "r",
			questionId: "r:ask-1",
			fromTaskId: "t",
			question: "Q?",
			blocking: false,
		});
		bus.emit("task:ask:answered", { runId: "r", questionId: "r:ask-1", answer: "A", recipients: ["t"] });
		bus.emit("task:ask:cancelled", { runId: "r", questionId: "r:ask-1", reason: "x" });

		expect(frames).toEqual([]);
	});
});

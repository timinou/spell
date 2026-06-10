/**
 * Project the in-process `task:ask:*` EventBus dialogue onto an RPC stdout
 * sink so spell-server can OBSERVE worker↔orchestrator Q&A (PLAN-331 W3').
 *
 * Observation-only: the human watches the dialogue; answers are composed
 * in-process by the orchestrator (PLAN-327 AskBroker), never over this channel.
 * One frame kind (`task_ask`) with three lifecycle phases keeps the ask
 * taxonomy distinct on the wire from blocking events (a separate answerable
 * path), avoiding double-delivery.
 */
import type { EventBus } from "../../utils/event-bus";
import type { RpcTaskAskEvent } from "./rpc-types";

/** Emits a projected frame onto the RPC stdout rail. */
export type TaskAskSink = (event: RpcTaskAskEvent) => void;

/**
 * Subscribe to the three `task:ask:*` channels and forward each as a
 * {@link RpcTaskAskEvent}. Returns an unsubscribe fn that detaches all three
 * (callers that run for the process lifetime, like `runRpcMode`, may ignore it).
 */
export function projectTaskAskEvents(eventBus: EventBus, sink: TaskAskSink): () => void {
	// The shared bus is untyped (EventMap default), matching the house pattern in
	// subagent-tracker.ts: cast each payload at the subscribe boundary. The shapes
	// are the SwarmEventMap `task:ask:*` payloads (see typed-event-map.ts).
	const unsubs = [
		eventBus.subscribe("task:ask:raised", raw => {
			const e = raw as {
				runId: string;
				questionId: string;
				fromTaskId: string;
				fromSessionId?: string;
				question: string;
				scopeHint?: string;
				blocking: boolean;
			};
			sink({
				type: "task_ask",
				phase: "raised",
				runId: e.runId,
				questionId: e.questionId,
				fromTaskId: e.fromTaskId,
				fromSessionId: e.fromSessionId,
				question: e.question,
				scopeHint: e.scopeHint,
				blocking: e.blocking,
			});
		}),
		eventBus.subscribe("task:ask:answered", raw => {
			const e = raw as { runId: string; questionId: string; answer: string; recipients: string[] };
			sink({
				type: "task_ask",
				phase: "answered",
				runId: e.runId,
				questionId: e.questionId,
				answer: e.answer,
				recipients: e.recipients,
			});
		}),
		eventBus.subscribe("task:ask:cancelled", raw => {
			const e = raw as { runId: string; questionId: string; reason: string };
			sink({
				type: "task_ask",
				phase: "cancelled",
				runId: e.runId,
				questionId: e.questionId,
				reason: e.reason,
			});
		}),
	];
	return () => {
		for (const unsub of unsubs) unsub();
	};
}

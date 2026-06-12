/**
 * Pure SessionState reducers extracted from stores.svelte.ts.
 * No runes here, so this module is import-safe from bun:test.
 */
import type {
	ArtifactCreatedEvent,
	BlockingEventPayload,
	EventLogEntry,
	ProcessInfoEvent,
	RpcEvent,
} from "./protocol";

export type BubbleKind =
	| "user"
	| "assistant"
	| "assistant_thinking"
	| "tool_start"
	| "tool_update"
	| "tool_end"
	| "blocking"
	| "system"
	| "external_log"
	| "artifact"
	| "ask"
	| "error";

export interface ChatBubble {
	id: string;
	kind: BubbleKind;
	ts: number;
	text?: string;
	toolName?: string;
	toolCallId?: string;
	intent?: string;
	isError?: boolean;
	args?: unknown;
	blocking?: BlockingEventPayload;
	artifact?: ArtifactCreatedEvent;
	/** task_ask dialogue (observation-only, PLAN-331 W3'): correlates raised→answered/cancelled in place. */
	ask?: { questionId: string; fromTaskId?: string; status: "pending" | "answered" | "cancelled"; question?: string; answer?: string; reason?: string };
}

export interface SessionStateCore {
	bubbles: ChatBubble[];
	pendingAssistant: ChatBubble | null;
	busy: boolean;
	latestProcessInfo: ProcessInfoEvent | null;
	stderrLog: Array<{ ts: number; line: string }>;
}

let bubbleCounter = 0;
export function newBubble(): string {
	bubbleCounter += 1;
	return `b${bubbleCounter}`;
}

/** Reset the bubble id counter; for deterministic tests. */
export function __resetBubbleCounterForTests(): void {
	bubbleCounter = 0;
}

export function pushUserBubble(s: SessionStateCore, text: string, ts = Date.now()): SessionStateCore {
	return {
		...s,
		busy: true,
		bubbles: [...s.bubbles, { id: newBubble(), kind: "user", ts, text }],
	};
}

export function appendExternalLog(s: SessionStateCore, entry: EventLogEntry): SessionStateCore {
	return {
		...s,
		bubbles: [
			...s.bubbles,
			{ id: newBubble(), kind: "external_log", ts: entry.ts, text: entry.text, toolName: entry.toolName },
		],
	};
}

export function appendArtifact(s: SessionStateCore, artifact: ArtifactCreatedEvent): SessionStateCore {
	return {
		...s,
		bubbles: [...s.bubbles, { id: newBubble(), kind: "artifact", ts: artifact.ts, artifact }],
	};
}

export function commitPending(s: SessionStateCore): SessionStateCore {
	if (!s.pendingAssistant) return s;
	const pending = s.pendingAssistant;
	if (pending.text && pending.text.length > 0) {
		return { ...s, pendingAssistant: null, bubbles: [...s.bubbles, pending] };
	}
	return { ...s, pendingAssistant: null };
}

export function applyRpcEvent(s: SessionStateCore, event: RpcEvent): SessionStateCore {
	switch (event.type) {
		case "agent_start":
		case "turn_start":
			return { ...s, busy: true };
		case "agent_end":
			return commitPending({ ...s, busy: false });
		case "turn_end":
			return commitPending(s);
		case "message_start":
			return { ...s, pendingAssistant: { id: newBubble(), kind: "assistant", ts: Date.now(), text: "" } };
		case "message_update": {
			const delta = event.assistantMessageEvent?.delta;
			if (!delta) return s;
			const target =
				s.pendingAssistant ?? ({ id: newBubble(), kind: "assistant" as const, ts: Date.now(), text: "" });
			if (delta.thinking) {
				const kind = target.text && target.text.length > 0 ? target.kind : "assistant_thinking";
				return {
					...s,
					pendingAssistant: { ...target, kind, text: (target.text ?? "") + delta.thinking },
				};
			}
			if (delta.text) {
				if (target.kind === "assistant_thinking") {
					const committed = commitPending(s);
					return {
						...committed,
						pendingAssistant: { id: newBubble(), kind: "assistant", ts: Date.now(), text: delta.text },
					};
				}
				return { ...s, pendingAssistant: { ...target, text: (target.text ?? "") + delta.text } };
			}
			return s;
		}
		case "message_end":
			return commitPending(s);
		case "tool_execution_start": {
			const committed = commitPending(s);
			return {
				...committed,
				bubbles: [
					...committed.bubbles,
					{
						id: newBubble(),
						kind: "tool_start",
						ts: Date.now(),
						toolName: event.toolName,
						toolCallId: event.toolCallId,
						intent: event.intent,
						args: event.args,
					},
				],
			};
		}
		case "tool_execution_end":
			return {
				...s,
				bubbles: [
					...s.bubbles,
					{
						id: newBubble(),
						kind: "tool_end",
						ts: Date.now(),
						toolName: event.toolName,
						toolCallId: event.toolCallId,
						isError: event.isError,
						text: event.result?.content
							?.map(c => c.text ?? "")
							.join("\n")
							.slice(0, 800),
					},
				],
			};
		case "error":
			return {
				...s,
				bubbles: [...s.bubbles, { id: newBubble(), kind: "error", ts: Date.now(), text: event.message }],
			};
		case "task_ask":
			return applyTaskAsk(s, event);
		default:
			return s;
	}
}

/**
 * Observation-only worker↔orchestrator dialogue (PLAN-331 W3'). `raised`
 * appends a pending `ask` bubble; `answered`/`cancelled` resolve the matching
 * bubble IN PLACE (keyed by questionId) so the lane reads as a dialogue, not a
 * log. An answer/cancel with no matching raised bubble is ignored (out-of-order
 * or pre-subscribe).
 */
function applyTaskAsk(s: SessionStateCore, event: Extract<RpcEvent, { type: "task_ask" }>): SessionStateCore {
	if (event.phase === "raised") {
		return {
			...s,
			bubbles: [
				...s.bubbles,
				{
					id: newBubble(),
					kind: "ask",
					ts: Date.now(),
					ask: {
						questionId: event.questionId,
						fromTaskId: event.fromTaskId,
						status: "pending",
						question: event.question,
					},
				},
			],
		};
	}
	let matched = false;
	const bubbles = s.bubbles.map(b => {
		if (b.kind !== "ask" || b.ask?.questionId !== event.questionId || b.ask.status !== "pending") return b;
		matched = true;
		return event.phase === "answered"
			? { ...b, ask: { ...b.ask, status: "answered" as const, answer: event.answer } }
			: { ...b, ask: { ...b.ask, status: "cancelled" as const, reason: event.reason } };
	});
	return matched ? { ...s, bubbles } : s;
}

export function pushBlocking(s: SessionStateCore, payload: BlockingEventPayload): SessionStateCore {
	return {
		...s,
		bubbles: [...s.bubbles, { id: newBubble(), kind: "blocking", ts: Date.now(), blocking: payload }],
	};
}

export function appendProcessInfo(s: SessionStateCore, info: ProcessInfoEvent): SessionStateCore {
	return { ...s, latestProcessInfo: info };
}

export function appendStderr(s: SessionStateCore, line: string, ts = Date.now()): SessionStateCore {
	const next = [...s.stderrLog, { ts, line }];
	if (next.length > 200) next.shift();
	return { ...s, stderrLog: next };
}

export function freshSessionStateCore(): SessionStateCore {
	return { bubbles: [], pendingAssistant: null, busy: false, latestProcessInfo: null, stderrLog: [] };
}

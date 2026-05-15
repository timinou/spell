/**
 * Pure SessionState reducers extracted from stores.svelte.ts.
 * No runes here, so this module is import-safe from bun:test.
 */
import type {
	ArtifactCreatedEvent,
	BlockingEventPayload,
	EventLogEntry,
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
}

export interface SessionStateCore {
	bubbles: ChatBubble[];
	pendingAssistant: ChatBubble | null;
	busy: boolean;
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
		default:
			return s;
	}
}

export function pushBlocking(s: SessionStateCore, payload: BlockingEventPayload): SessionStateCore {
	return {
		...s,
		bubbles: [...s.bubbles, { id: newBubble(), kind: "blocking", ts: Date.now(), blocking: payload }],
	};
}

export function freshSessionStateCore(): SessionStateCore {
	return { bubbles: [], pendingAssistant: null, busy: false };
}

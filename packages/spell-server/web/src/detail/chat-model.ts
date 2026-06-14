/**
 * Pure reducer: fold a stream of RpcEvents into an ordered list of chat bubbles
 * for structured DOM rendering. Replaces the ANSI accumulation of
 * the previous ANSI terminal renderer. No React — unit-testable headlessly.
 *
 * Design mirrors the spell-server RpcEvent wire protocol (rpc/types.ts):
 *  - message_update text/thinking deltas accumulate into one assistant bubble
 *    per message; thinking and text split into distinct bubbles.
 *  - tool_execution_start opens a `tool` bubble (keyed by toolCallId); the
 *    matching tool_execution_end fills in its result text + error flag so the
 *    call and its result render as ONE tile rather than two slabs.
 *  - external (event_log) entries map to bubbles too, so terminal-session
 *    mirroring shares the same renderer.
 */

import type { BlockingEventPayload } from "../api/client";

export type BubbleKind =
	| "user"
	| "assistant"
	| "assistant_thinking"
	| "tool"
	| "blocking"
	| "ask"
	| "error"
	| "system";

export interface ChatBubble {
	id: string;
	kind: BubbleKind;
	ts: number;
	text?: string;
	/** tool bubbles: */
	toolName?: string;
	toolCallId?: string;
	intent?: string;
	args?: unknown;
	/** filled when the tool_execution_end for this call arrives */
	resultText?: string;
	isError?: boolean;
	pending?: boolean;
	/** blocking/ask payloads */
	blocking?: BlockingEventPayload;
	ask?: { questionId: string; fromTaskId?: string; status: "pending" | "answered" | "cancelled"; question?: string; answer?: string; reason?: string };
}

// ── Wire event shapes (subset we consume; mirrors rpc/types.ts) ─────────────
interface AssistantDelta { type: string; delta?: string; content?: string; reason?: string; error?: { errorMessage?: string } }
export interface StreamRpcEvent {
	type: string;
	assistantMessageEvent?: AssistantDelta;
	toolCallId?: string;
	toolName?: string;
	intent?: string;
	args?: unknown;
	isError?: boolean;
	result?: { content?: Array<{ type?: string; text?: string }> };
	message?: string;
	// task_ask
	phase?: "raised" | "answered" | "cancelled";
	questionId?: string;
	fromTaskId?: string;
	question?: string;
	answer?: string;
	reason?: string;
}

export interface ChatState {
	bubbles: ChatBubble[];
	/** open assistant bubble accumulating deltas, if any */
	pendingAssistantId: string | null;
}

export function emptyChat(): ChatState {
	return { bubbles: [], pendingAssistantId: null };
}

let counter = 0;
function nextId(): string {
	counter += 1;
	return `cb${counter}`;
}
/** Test-only deterministic reset. */
export function __resetChatIds(): void {
	counter = 0;
}

function resultText(result: StreamRpcEvent["result"]): string | undefined {
	const text = result?.content?.map(c => c.text ?? "").join("\n").trim();
	return text && text.length > 0 ? text : undefined;
}

/** Fold one RpcEvent into the chat state, returning a new state. */
export function reduceEvent(state: ChatState, event: StreamRpcEvent, now = Date.now()): ChatState {
	switch (event.type) {
		case "message_start":
			return { ...state, pendingAssistantId: null };
		case "message_update": {
			const inner = event.assistantMessageEvent;
			if (!inner) return state;
			if (inner.type === "thinking_delta" && inner.delta) {
				return appendAssistantDelta(state, inner.delta, "assistant_thinking", now);
			}
			if (inner.type === "text_delta" && inner.delta) {
				return appendAssistantDelta(state, inner.delta, "assistant", now);
			}
			return state;
		}
		case "message_end":
			return { ...state, pendingAssistantId: null };
		case "tool_execution_start": {
			const bubble: ChatBubble = {
				id: nextId(),
				kind: "tool",
				ts: now,
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				intent: event.intent,
				args: event.args,
				pending: true,
			};
			return { ...state, bubbles: [...state.bubbles, bubble], pendingAssistantId: null };
		}
		case "tool_execution_end": {
			const text = resultText(event.result);
			const bubbles = state.bubbles.slice();
			// Fill the matching open tool bubble (last one with this callId).
			for (let i = bubbles.length - 1; i >= 0; i--) {
				const b = bubbles[i];
				if (b.kind === "tool" && b.toolCallId === event.toolCallId && b.pending) {
					bubbles[i] = { ...b, pending: false, resultText: text, isError: event.isError };
					return { ...state, bubbles };
				}
			}
			// No matching start (out of order): synthesise a standalone result tile.
			bubbles.push({ id: nextId(), kind: "tool", ts: now, toolName: event.toolName, toolCallId: event.toolCallId, resultText: text, isError: event.isError });
			return { ...state, bubbles };
		}
		case "task_ask":
			return reduceTaskAsk(state, event, now);
		case "error":
			return { ...state, bubbles: [...state.bubbles, { id: nextId(), kind: "error", ts: now, text: event.message, isError: true }], pendingAssistantId: null };
		default:
			return state;
	}
}

function appendAssistantDelta(state: ChatState, delta: string, kind: "assistant" | "assistant_thinking", now: number): ChatState {
	const open = state.pendingAssistantId ? state.bubbles.find(b => b.id === state.pendingAssistantId) : undefined;
	// A kind switch (thinking↔text) starts a fresh bubble.
	if (open && open.kind === kind) {
		const bubbles = state.bubbles.map(b => (b.id === open.id ? { ...b, text: (b.text ?? "") + delta } : b));
		return { ...state, bubbles };
	}
	const bubble: ChatBubble = { id: nextId(), kind, ts: now, text: delta };
	return { ...state, bubbles: [...state.bubbles, bubble], pendingAssistantId: bubble.id };
}

function reduceTaskAsk(state: ChatState, event: StreamRpcEvent, now: number): ChatState {
	if (event.phase === "raised") {
		const bubble: ChatBubble = {
			id: nextId(),
			kind: "ask",
			ts: now,
			ask: { questionId: event.questionId ?? "", fromTaskId: event.fromTaskId, status: "pending", question: event.question },
		};
		return { ...state, bubbles: [...state.bubbles, bubble] };
	}
	// answered/cancelled: resolve the matching pending ask in place.
	const bubbles = state.bubbles.map(b => {
		if (b.kind === "ask" && b.ask && b.ask.questionId === event.questionId && b.ask.status === "pending") {
			return {
				...b,
				ask: {
					...b.ask,
					status: (event.phase === "answered" ? "answered" : "cancelled") as "answered" | "cancelled",
					answer: event.answer,
					reason: event.reason,
				},
			};
		}
		return b;
	});
	return { ...state, bubbles };
}

/** Map an external event_log entry to a bubble (terminal-session mirroring). */
export function reduceLogEntry(
	state: ChatState,
	entry: { kind: string; ts: number; text?: string; toolName?: string },
): ChatState {
	switch (entry.kind) {
		case "user_message":
			return { ...state, bubbles: [...state.bubbles, { id: nextId(), kind: "user", ts: entry.ts, text: entry.text }] };
		case "assistant_text":
			return { ...state, bubbles: [...state.bubbles, { id: nextId(), kind: "assistant", ts: entry.ts, text: entry.text }] };
		case "tool_call":
			// External (event_log) tool calls have no correlated end, so they are
			// historical markers, not pending — render as a labelled tile.
			return { ...state, bubbles: [...state.bubbles, { id: nextId(), kind: "tool", ts: entry.ts, toolName: entry.toolName }] };
		case "tool_result":
			return { ...state, bubbles: [...state.bubbles, { id: nextId(), kind: "tool", ts: entry.ts, toolName: entry.toolName, resultText: entry.text }] };
		case "error":
			return { ...state, bubbles: [...state.bubbles, { id: nextId(), kind: "error", ts: entry.ts, text: entry.text, isError: true }] };
		case "turn_start":
		case "turn_end":
			return state; // turn markers are noise in the DOM view
		default:
			return entry.text ? { ...state, bubbles: [...state.bubbles, { id: nextId(), kind: "system", ts: entry.ts, text: entry.text }] } : state;
	}
}

import type {
	ArtifactCreatedEvent,
	BlockingEventPayload,
	EventLogEntry,
	RpcEvent,
	SessionSummary,
} from "./protocol";

/* -- Chat log model ---------------------------------------------------- */
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
	/** Free-text payload (markdown-ish). */
	text?: string;
	toolName?: string;
	toolCallId?: string;
	intent?: string;
	isError?: boolean;
	args?: unknown;
	blocking?: BlockingEventPayload;
	artifact?: ArtifactCreatedEvent;
}

let bubbleCounter = 0;
function newBubble(): string {
	bubbleCounter += 1;
	return `b${bubbleCounter}`;
}

/* -- Per-session live state ------------------------------------------- */
export interface SessionState {
	summary: SessionSummary;
	bubbles: ChatBubble[];
	/** Live-assembled assistant message; rendered as a single growing bubble. */
	pendingAssistant: ChatBubble | null;
	/** True while a turn is in flight. */
	busy: boolean;
}

function freshState(summary: SessionSummary): SessionState {
	return { summary, bubbles: [], pendingAssistant: null, busy: false };
}

/* -- Root app store ---------------------------------------------------- */
class AppStore {
	#sessions = $state(new Map<string, SessionState>());
	selected = $state<string | null>(null);
	wsStatus = $state<"connecting" | "open" | "auth_ok" | "closed">("connecting");
	theme = $state<"light" | "dark">(
		typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
	);
	identity = $state<string | null>(null);

	get sessions(): Map<string, SessionState> {
		return this.#sessions;
	}

	/** Stable, sorted view: spawned first, then external; recent first. */
	orderedSessions = $derived.by(() => {
		const arr = [...this.#sessions.values()];
		arr.sort((a, b) => {
			if (a.summary.kind !== b.summary.kind) return a.summary.kind === "spawned" ? -1 : 1;
			return b.summary.startedAt - a.summary.startedAt;
		});
		return arr;
	});

	current = $derived.by(() => (this.selected ? this.#sessions.get(this.selected) ?? null : null));

	setAll(summaries: SessionSummary[]): void {
		const next = new Map(this.#sessions);
		const seen = new Set(summaries.map(s => s.sessionId));
		for (const id of [...next.keys()]) {
			if (!seen.has(id)) next.delete(id);
		}
		for (const s of summaries) {
			const existing = next.get(s.sessionId);
			if (existing) {
				existing.summary = s;
			} else {
				next.set(s.sessionId, freshState(s));
			}
		}
		this.#sessions = next;
	}

	upsert(summary: SessionSummary): void {
		const existing = this.#sessions.get(summary.sessionId);
		if (existing) {
			existing.summary = summary;
			this.#sessions = new Map(this.#sessions);
		} else {
			const next = new Map(this.#sessions);
			next.set(summary.sessionId, freshState(summary));
			this.#sessions = next;
		}
	}

	remove(sessionId: string): void {
		if (!this.#sessions.has(sessionId)) return;
		const next = new Map(this.#sessions);
		next.delete(sessionId);
		this.#sessions = next;
		if (this.selected === sessionId) this.selected = null;
	}

	select(sessionId: string | null): void {
		this.selected = sessionId;
	}

	/** Immutable-update: replace the SessionState in the Map and reassign,
	 * so Svelte 5's $derived(current) sees a new ref and downstream
	 * $derived(sessionState.bubbles) re-runs. Plain Map values are NOT
	 * deeply proxied by $state, so we must propagate fresh refs ourselves.
	 */
	#update(sessionId: string, patch: (s: SessionState) => SessionState): void {
		const old = this.#sessions.get(sessionId);
		if (!old) return;
		const next = new Map(this.#sessions);
		next.set(sessionId, patch(old));
		this.#sessions = next;
	}

	pushUserPrompt(sessionId: string, text: string): void {
		this.#update(sessionId, s => ({
			...s,
			busy: true,
			bubbles: [...s.bubbles, { id: newBubble(), kind: "user", ts: Date.now(), text }],
		}));
	}

	noteRpcEvent(sessionId: string, event: RpcEvent): void {
		this.#update(sessionId, s => applyRpcEvent(s, event));
	}

	noteExternalLog(sessionId: string, entry: EventLogEntry): void {
		this.#update(sessionId, s => ({
			...s,
			bubbles: [
				...s.bubbles,
				{ id: newBubble(), kind: "external_log", ts: entry.ts, text: entry.text, toolName: entry.toolName },
			],
		}));
	}

	noteBlocking(sessionId: string, payload: BlockingEventPayload): void {
		this.#update(sessionId, s => ({
			...s,
			summary: { ...s.summary, currentBlockingEvent: payload },
			bubbles: [...s.bubbles, { id: newBubble(), kind: "blocking", ts: Date.now(), blocking: payload }],
		}));
	}

	clearBlocking(sessionId: string): void {
		this.#update(sessionId, s => ({
			...s,
			summary: { ...s.summary, currentBlockingEvent: undefined },
		}));
	}

	noteArtifact(sessionId: string, artifact: ArtifactCreatedEvent): void {
		this.#update(sessionId, s => ({
			...s,
			bubbles: [...s.bubbles, { id: newBubble(), kind: "artifact", ts: artifact.ts, artifact }],
		}));
	}

}

export const app = new AppStore();


function applyRpcEvent(s: SessionState, event: RpcEvent): SessionState {
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
						text: event.result?.content?.map(c => c.text ?? "").join("\n").slice(0, 800),
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

function commitPending(s: SessionState): SessionState {
	if (!s.pendingAssistant) return s;
	const pending = s.pendingAssistant;
	if (pending.text && pending.text.length > 0) {
		return { ...s, pendingAssistant: null, bubbles: [...s.bubbles, pending] };
	}
	return { ...s, pendingAssistant: null };
}

/* -- Toast store ------------------------------------------------------- */
export type ToastKind = "info" | "success" | "error";
export interface Toast { id: string; kind: ToastKind; message: string }

class ToastStore {
	items = $state<Toast[]>([]);
	#counter = 0;
	push(kind: ToastKind, message: string, ttlMs = 4000): void {
		this.#counter += 1;
		const id = `t${this.#counter}`;
		this.items = [...this.items, { id, kind, message }];
		setTimeout(() => {
			this.items = this.items.filter(t => t.id !== id);
		}, ttlMs);
	}
}

export const toasts = new ToastStore();

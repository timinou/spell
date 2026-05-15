import type {
	ArtifactCreatedEvent,
	BlockingEventPayload,
	EventLogEntry,
	ProcessInfoEvent,
	RpcEvent,
	SessionSummary,
} from "./protocol";
import {
	type ChatBubble,
	type SessionStateCore,
	applyRpcEvent,
	appendArtifact,
	appendExternalLog,
	appendProcessInfo,
	appendStderr,
	freshSessionStateCore,
	newBubble,
	pushBlocking,
	pushUserBubble,
} from "./reducers";

export type { BubbleKind, ChatBubble, SessionStateCore } from "./reducers";

/* -- Per-session live state ------------------------------------------- */
export interface SessionState extends SessionStateCore {
	summary: SessionSummary;
}

function freshState(summary: SessionSummary): SessionState {
	return { summary, ...freshSessionStateCore() };
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

	#update(sessionId: string, patch: (s: SessionState) => SessionState): void {
		const old = this.#sessions.get(sessionId);
		if (!old) return;
		const next = new Map(this.#sessions);
		next.set(sessionId, patch(old));
		this.#sessions = next;
	}

	pushUserPrompt(sessionId: string, text: string): void {
		this.#update(sessionId, s => ({ ...s, ...pushUserBubble(s, text) }));
	}

	noteRpcEvent(sessionId: string, event: RpcEvent): void {
		this.#update(sessionId, s => ({ ...applyRpcEvent(s, event), summary: s.summary }));
	}

	noteExternalLog(sessionId: string, entry: EventLogEntry): void {
		this.#update(sessionId, s => ({ ...s, ...appendExternalLog(s, entry) }));
	}

	noteBlocking(sessionId: string, payload: BlockingEventPayload): void {
		this.#update(sessionId, s => ({
			...s,
			...pushBlocking(s, payload),
			summary: { ...s.summary, currentBlockingEvent: payload },
		}));
	}

	clearBlocking(sessionId: string): void {
		this.#update(sessionId, s => ({ ...s, summary: { ...s.summary, currentBlockingEvent: undefined } }));
	}

	noteArtifact(sessionId: string, artifact: ArtifactCreatedEvent): void {
		this.#update(sessionId, s => ({ ...s, ...appendArtifact(s, artifact) }));
	}

	noteProcessInfo(sessionId: string, info: ProcessInfoEvent): void {
		this.#update(sessionId, s => ({ ...s, ...appendProcessInfo(s, info) }));
	}

	noteStderr(sessionId: string, line: string, ts?: number): void {
		this.#update(sessionId, s => ({ ...s, ...appendStderr(s, line, ts) }));
	}
}

export const app = new AppStore();

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

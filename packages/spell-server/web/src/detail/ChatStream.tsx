import { useEffect, useReducer, useRef, useState } from "react";
import type { EventResponsePayload } from "../api/client";
import type { DerivedSession } from "../state/sessions";
import { BlockingEventCard } from "./BlockingEventCard";
import { ChatBubbleView } from "./ChatBubble";
import { emptyChat, reduceEvent, reduceLogEntry, type ChatState, type StreamRpcEvent } from "./chat-model";

type DeliverAs = "steer" | "followUp" | "auto";

export interface ChatStreamProps {
	session: DerivedSession;
	subscribeRpcEvents: (sessionId: string, listener: (event: { type: string }) => void) => () => void;
	submitPrompt?: (sessionId: string, message: string, deliverAs?: DeliverAs) => Promise<void>;
	abort?: (sessionId: string) => Promise<void>;
	answerBlockingEvent?: (sessionId: string, eventId: string, payload: EventResponsePayload) => void;
}

type ChatAction = { kind: "event"; event: StreamRpcEvent } | { kind: "log"; entry: DerivedSession["logs"][number] } | { kind: "reset" };

function chatReducer(state: ChatState, action: ChatAction): ChatState {
	switch (action.kind) {
		case "event":
			return reduceEvent(state, action.event);
		case "log":
			return reduceLogEntry(state, action.entry);
		case "reset":
			return emptyChat();
	}
}

/**
 * Structured DOM chat stream. Replaces the xterm terminal: RPC events fold into
 * bubbles (chat-model) and render as tiles (ChatBubble) — assistant text,
 * thinking, tool calls with target chips + diff-colored results, undo/redo
 * accents, dialogue, errors.
 */
export function ChatStream(props: ChatStreamProps) {
	const { session, subscribeRpcEvents, submitPrompt, abort, answerBlockingEvent } = props;
	const [chat, dispatch] = useReducer(chatReducer, undefined, emptyChat);
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [deliverAs, setDeliverAs] = useState<DeliverAs>("auto");
	const isExternal = session.kind === "external";
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const pinnedToBottom = useRef(true);
	const writtenLogCount = useRef(0);

	// Subscribe to live spawned-session events.
	useEffect(() => {
		dispatch({ kind: "reset" });
		writtenLogCount.current = 0;
		// Seed from any already-buffered external logs.
		for (const entry of session.logs) dispatch({ kind: "log", entry });
		writtenLogCount.current = session.logs.length;
		const unsub = subscribeRpcEvents(session.sessionId, evt => {
			dispatch({ kind: "event", event: evt as StreamRpcEvent });
		});
		return () => unsub();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [session.sessionId]);

	// Append new external (event_log) entries as they arrive.
	useEffect(() => {
		const logs = session.logs;
		if (logs.length < writtenLogCount.current) {
			writtenLogCount.current = logs.length;
			return;
		}
		for (let i = writtenLogCount.current; i < logs.length; i++) dispatch({ kind: "log", entry: logs[i] });
		writtenLogCount.current = logs.length;
	}, [session.logs]);

	// Auto-scroll to bottom unless the user scrolled up.
	useEffect(() => {
		const el = scrollRef.current;
		if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
	}, [chat.bubbles]);

	function onScroll(e: React.UIEvent<HTMLDivElement>) {
		const el = e.currentTarget;
		pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
	}

	async function send() {
		if (!submitPrompt || draft.trim().length === 0) return;
		setBusy(true);
		try {
			await submitPrompt(session.sessionId, draft, isExternal ? deliverAs : undefined);
			setDraft("");
		} finally {
			setBusy(false);
		}
	}

	const hint = isExternal
		? "Steer this terminal session as if typed locally (Cmd+Enter)"
		: "Send a follow-up prompt (Cmd+Enter to submit)";

	return (
		<div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
			<div className="chat-log" ref={scrollRef} onScroll={onScroll}>
				{chat.bubbles.length === 0 ? (
					<div className="chat-empty muted">
						{isExternal ? "Streaming from an external spell session…" : "Send a prompt to get started."}
					</div>
				) : (
					chat.bubbles.map(b => <ChatBubbleView key={b.id} bubble={b} />)
				)}
			</div>
			{session.currentBlockingEvent && answerBlockingEvent && (
				<BlockingEventCard
					event={session.currentBlockingEvent}
					onAnswer={(eventId, payload) => answerBlockingEvent(session.sessionId, eventId, payload)}
				/>
			)}
			{submitPrompt && (
				<div className="prompt-input">
					<textarea
						value={draft}
						placeholder={hint}
						onChange={e => setDraft(e.target.value)}
						onKeyDown={e => {
							if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
								e.preventDefault();
								void send();
							}
						}}
					/>
					<div className="row">
						<div style={{ display: "flex", gap: 6, alignItems: "center" }}>
							{isExternal && (
								<div className="deliver-toggle" role="radiogroup" aria-label="Delivery mode">
									{(["auto", "steer", "followUp"] as DeliverAs[]).map(mode => (
										<button
											key={mode}
											type="button"
											role="radio"
											aria-checked={deliverAs === mode}
											className={`seg${deliverAs === mode ? " active" : ""}`}
											onClick={() => setDeliverAs(mode)}
										>
											{mode === "followUp" ? "Follow-up" : mode === "steer" ? "Steer" : "Auto"}
										</button>
									))}
								</div>
							)}
							<span>session {session.sessionId}</span>
						</div>
						<div style={{ display: "flex", gap: 6 }}>
							{abort && (
								<button className="btn" onClick={() => abort(session.sessionId)}>
									Abort
								</button>
							)}
							<button className="btn btn-primary" onClick={send} disabled={busy || draft.trim().length === 0}>
								Send
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

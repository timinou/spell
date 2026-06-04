import { useEffect, useRef, useState } from "react";
import type { EventResponsePayload } from "../api/client";
import type { DerivedSession } from "../state/sessions";
import { BlockingEventCard } from "./BlockingEventCard";
import { renderEventLogEntry, renderRpcEvent } from "./StreamRenderer";
import { attachTerminal, makeTerminal, type SpellTerminal } from "./xterm-setup";

type DeliverAs = "steer" | "followUp" | "auto";

export interface StreamTabProps {
	session: DerivedSession;
	subscribeRpcEvents: (sessionId: string, listener: (event: { type: string }) => void) => () => void;
	submitPrompt?: (sessionId: string, message: string, deliverAs?: DeliverAs) => Promise<void>;
	abort?: (sessionId: string) => Promise<void>;
	answerBlockingEvent?: (sessionId: string, eventId: string, payload: EventResponsePayload) => void;
}

export function StreamTab(props: StreamTabProps) {
	const { session, subscribeRpcEvents, submitPrompt, abort, answerBlockingEvent } = props;
	const hostRef = useRef<HTMLDivElement | null>(null);
	const termRef = useRef<SpellTerminal | null>(null);
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [deliverAs, setDeliverAs] = useState<DeliverAs>("auto");
	const isExternal = session.kind === "external";

	useEffect(() => {
		if (!hostRef.current) return;
		const term = makeTerminal();
		termRef.current = term;
		const detach = attachTerminal(term, hostRef.current);
		for (const entry of session.logs) term.term.write(renderEventLogEntry(entry));
		const unsub = subscribeRpcEvents(session.sessionId, evt => {
			if (!termRef.current) return;
			term.term.write(renderRpcEvent(evt as Parameters<typeof renderRpcEvent>[0]));
		});
		return () => {
			unsub();
			detach();
			term.dispose();
			termRef.current = null;
		};
	}, [session.sessionId]);

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

	// External (terminal) sessions are steered by injecting a real user turn;
	// the Steer/Follow-up toggle maps to the inject delivery mode. Spawned
	// sessions just take a plain follow-up prompt.
	const hint = isExternal
		? "Steer this terminal session as if typed locally (Cmd+Enter)"
		: "Send a follow-up prompt (Cmd+Enter to submit)";
	return (
		<div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
			<div className="term-host" ref={hostRef} style={{ flex: 1, minHeight: 0 }} />
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

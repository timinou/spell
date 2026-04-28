import { useEffect, useRef, useState } from "react";
import type { DerivedSession } from "../state/sessions";
import { renderEventLogEntry, renderRpcEvent } from "./StreamRenderer";
import { attachTerminal, makeTerminal, type SpellTerminal } from "./xterm-setup";

export interface StreamTabProps {
	session: DerivedSession;
	subscribeRpcEvents: (sessionId: string, listener: (event: { type: string }) => void) => () => void;
	submitPrompt?: (sessionId: string, message: string) => Promise<void>;
	abort?: (sessionId: string) => Promise<void>;
}

export function StreamTab(props: StreamTabProps) {
	const { session, subscribeRpcEvents, submitPrompt, abort } = props;
	const hostRef = useRef<HTMLDivElement | null>(null);
	const termRef = useRef<SpellTerminal | null>(null);
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
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
			await submitPrompt(session.sessionId, draft);
			setDraft("");
		} finally {
			setBusy(false);
		}
	}

	const hint = "Send a follow-up prompt (Cmd+Enter to submit)";
	return (
		<div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
			<div className="term-host" ref={hostRef} style={{ flex: 1, minHeight: 0 }} />
			{!isExternal && (
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
						<span>session {session.sessionId}</span>
						<div style={{ display: "flex", gap: 6 }}>
							{abort && (
								<button className="btn" onClick={() => abort(session.sessionId)}>
									Abort
								</button>
							)}
							<button className="btn btn-primary" onClick={send} disabled={busy || draft.length === 0}>
								Send
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

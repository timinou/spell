import { useMemo } from "react";
import { useSessions, type DerivedSession } from "../state/sessions";
import { SessionCard } from "./SessionCard";

export function SessionList() {
	const sessions = useSessions(s => s.sessions);
	const selected = useSessions(s => s.selected);
	const select = useSessions(s => s.select);

	const ordered = useMemo(() => {
		const arr = [...sessions.values()];
		arr.sort((a, b) => {
			if (a.kind !== b.kind) return a.kind === "spawned" ? -1 : 1;
			return b.startedAt - a.startedAt;
		});
		return arr;
	}, [sessions]);

	if (ordered.length === 0) {
		return (
			<div style={{ padding: 16 }} className="muted">
				No sessions yet. Press <kbd>{"\u2318K"}</kbd> to launch a template.
			</div>
		);
	}

	return (
		<div className="session-list">
			{ordered.map(session => (
				<SessionCard
					key={session.sessionId}
					session={session as DerivedSession}
					selected={session.sessionId === selected}
					onSelect={() => select(session.sessionId)}
				/>
			))}
		</div>
	);
}

import type { DerivedSession } from "../state/sessions";

function statusClass(status: DerivedSession["status"]): string {
	return `dot ${status}`;
}

function shorten(value: string, max = 36): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max - 1)}\u2026`;
}

export function SessionCard({
	session,
	selected,
	onSelect,
}: {
	session: DerivedSession;
	selected: boolean;
	onSelect: () => void;
}) {
	const title = session.templateName ?? session.projectName ?? session.sessionId;
	return (
		<div className={`session-card${selected ? " selected" : ""}`} onClick={onSelect} role="button" tabIndex={0}
			onKeyDown={e => {
				if (e.key === "Enter" || e.key === " ") onSelect();
			}}>
			<div className="row">
				<div className="name" title={title}>{title}</div>
				<span className={statusClass(session.status)} title={session.status} />
			</div>
			<div className="row meta">
				<span>{shorten(session.cwd, 32)}</span>
				<div className="badges">
					{session.kind === "spawned" && session.ownedBy && <span className="badge owner">{session.ownedBy}</span>}
					{session.kind === "external" && <span className="badge">CLI</span>}
					{session.ready && <span className="badge ready">READY</span>}
				</div>
			</div>
			{session.lastText && <div className="meta" style={{ marginTop: 2 }}>{shorten(session.lastText, 64)}</div>}
		</div>
	);
}

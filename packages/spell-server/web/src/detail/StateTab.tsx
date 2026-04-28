import type { DerivedSession } from "../state/sessions";

function fmtTime(ts: number): string {
	if (!ts) return "";
	return new Date(ts).toLocaleString();
}

export function StateTab({ session }: { session: DerivedSession }) {
	const rows: Array<[string, string]> = [
		["Session ID", session.sessionId],
		["Kind", session.kind],
		["Project", session.projectName],
		["CWD", session.cwd],
		["Mode", session.mode],
		["PID", String(session.pid)],
		["Owned by", session.ownedBy ?? "\u2014"],
		["Template", session.templateName ?? "\u2014"],
		["Watch ext", (session.watchExtensions ?? []).join(", ") || "\u2014"],
		["Started", fmtTime(session.startedAt)],
		["Last heartbeat", fmtTime(session.lastHeartbeat)],
		["Status", session.status],
		["Ready", session.ready ? "yes" : "no"],
	];
	return (
		<div className="pane">
			<table className="detail-state-table">
				<tbody>
					{rows.map(([k, v]) => (
						<tr key={k}>
							<td>{k}</td>
							<td>{v}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

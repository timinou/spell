import { useMemo } from "react";
import type { DisciplineRuntimeStat, DisciplineGateOutcome } from "../api/client";

interface Props {
	sessionId: string;
	disciplineStats?: DisciplineRuntimeStat[] | null;
	lastOutcomes?: DisciplineGateOutcome[] | null;
	onClose: () => void;
}

function ago(isoTime: string | undefined): string {
	if (!isoTime) return "-";
	try {
		const ts = new Date(isoTime).getTime() / 1000;
		const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
		if (s < 60) return `${s}s ago`;
		if (s < 3600) return `${Math.floor(s / 60)}m ago`;
		if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
		return `${Math.floor(s / 86400)}d ago`;
	} catch {
		return "-";
	}
}

function gateLabel(gate: string): string {
	switch (gate) {
		case "open-work":
			return "open";
		case "verify-cmd":
			return "cmd";
		case "verify-review":
			return "review";
		case "guard":
			return "guard";
		default:
			return gate;
	}
}

function formatGateBreakdown(breakdown: Partial<Record<string, number>>): string {
	const parts = Object.entries(breakdown)
		.filter(([, count]) => (count ?? 0) > 0)
		.map(([gate, count]) => `${gateLabel(gate)}:${count}`);
	return parts.length > 0 ? parts.join(" · ") : "-";
}

export function DisciplinesPanel({ sessionId, disciplineStats, lastOutcomes, onClose }: Props) {
	const empty = !disciplineStats || disciplineStats.length === 0;

	const outcomeMap = useMemo(() => {
		const map = new Map<string, DisciplineGateOutcome>();
		if (lastOutcomes) {
			for (const outcome of lastOutcomes) {
				map.set(outcome.discipline, outcome);
			}
		}
		return map;
	}, [lastOutcomes]);

	return (
		<aside className="hist-panel">
			<header className="hist-head">
				<span className="hist-title">Disciplines</span>
				{disciplineStats && <span className="hist-count">{disciplineStats.length} armed</span>}
				<button className="btn icon" onClick={onClose} title="Close" style={{ marginLeft: "auto" }}>
					✕
				</button>
			</header>

			<div className="hist-list">
				{empty && <div className="hist-empty muted">No armed disciplines.</div>}
				{!empty && (
					<table style={{ width: "100%", fontSize: "0.9em", borderCollapse: "collapse" }}>
						<thead>
							<tr style={{ borderBottom: "1px solid var(--border)" }}>
								<th style={{ textAlign: "left", padding: "0.5em", fontWeight: 600 }}>Name</th>
								<th style={{ textAlign: "center", padding: "0.5em", fontWeight: 600 }}>Guard</th>
								<th style={{ textAlign: "center", padding: "0.5em", fontWeight: 600 }}>Verify</th>
								<th style={{ textAlign: "left", padding: "0.5em", fontWeight: 600 }}>Armed</th>
								<th style={{ textAlign: "center", padding: "0.5em", fontWeight: 600 }}>Count</th>
								<th style={{ textAlign: "left", padding: "0.5em", fontWeight: 600 }}>Last Fired</th>
								<th style={{ textAlign: "center", padding: "0.5em", fontWeight: 600 }}>Status</th>
								<th style={{ textAlign: "left", padding: "0.5em", fontWeight: 600 }}>Gates</th>
							</tr>
						</thead>
						<tbody>
							{disciplineStats.map(stat => {
								const lastOutcome = outcomeMap.get(stat.name) ?? stat.lastOutcome;
								return (
									<tr key={stat.name} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
										<td style={{ padding: "0.5em", fontWeight: 500 }}>{stat.name}</td>
										<td style={{ textAlign: "center", padding: "0.5em", fontSize: "0.85em", color: "var(--muted)" }}>
											{stat.guard || "-"}
										</td>
										<td style={{ textAlign: "center", padding: "0.5em" }}>
											{stat.verifyCmd || stat.verifyReview ? (
												<span style={{ fontSize: "0.85em" }}>
													{stat.verifyCmd && <span title="cmd">✓</span>}
													{stat.verifyCmd && stat.verifyReview && " "}
													{stat.verifyReview && <span title="review">✓</span>}
												</span>
											) : (
												<span style={{ color: "var(--muted)" }}>-</span>
											)}
										</td>
										<td style={{ padding: "0.5em", fontSize: "0.85em", color: "var(--muted)" }}>
											{ago(stat.armedAt)}
										</td>
										<td style={{ textAlign: "center", padding: "0.5em", fontWeight: 500 }}>
											{stat.activationCount}
										</td>
										<td style={{ padding: "0.5em", fontSize: "0.85em", color: "var(--muted)" }}>
											{ago(stat.lastFiredAt)}
										</td>
										<td
											style={{
												textAlign: "center",
												padding: "0.5em",
												color: lastOutcome?.passed ? "var(--success)" : "var(--error)",
											}}
										>
											{lastOutcome ? (lastOutcome.passed ? "✓" : "✗") : "-"}
										</td>
										<td style={{ padding: "0.5em", fontSize: "0.85em", color: "var(--muted)" }}>
											{formatGateBreakdown(stat.gateBreakdown)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				)}
			</div>

			<footer className="hist-foot dim small">Discipline runtime statistics from session start and yield events.</footer>
		</aside>
	);
}

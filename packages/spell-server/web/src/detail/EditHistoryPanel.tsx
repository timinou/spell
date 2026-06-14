import { useCallback, useEffect, useMemo, useState } from "react";
import type { EditHistoryData, EditHistoryEntry } from "../api/client";

type Lens = "all" | "undoable" | "redoable" | "committed";

interface Props {
	sessionId: string;
	loadEditHistory: (sessionId: string, file?: string) => Promise<EditHistoryData>;
	/** FEAT-815: undo a recorded edit by its entry id (force overrides commit guard). */
	onUndo?: (sessionId: string, entryId?: string, force?: boolean) => Promise<unknown>;
	/** FEAT-815: redo a previously-undone edit by its entry id. */
	onRedo?: (sessionId: string, entryId?: string) => Promise<unknown>;
	onClose: () => void;
}

function basename(p: string): string {
	const i = p.lastIndexOf("/");
	return i >= 0 ? p.slice(i + 1) : p;
}
function shortWorkspace(p: string): string {
	return basename(p.replace(/\/+$/, "")) || p;
}
function ago(unixSec: number): string {
	const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSec));
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

interface Group {
	groupId: string;
	entries: EditHistoryEntry[];
	newest: number;
	committed: boolean;
	reverted: boolean;
	workspace: string;
	actor: string;
}

function groupEntries(entries: EditHistoryEntry[]): Group[] {
	const map = new Map<string, EditHistoryEntry[]>();
	for (const e of entries) {
		const key = e.groupId ?? `solo:${e.id}`;
		const arr = map.get(key);
		if (arr) arr.push(e);
		else map.set(key, [e]);
	}
	const groups: Group[] = [];
	for (const [groupId, es] of map) {
		groups.push({
			groupId,
			entries: es,
			newest: Math.max(...es.map(e => e.timestamp)),
			committed: es.some(e => e.committed),
			reverted: es.every(e => e.reverted),
			workspace: es[0].workspace,
			actor: es[0].agentLabel,
		});
	}
	groups.sort((a, b) => b.newest - a.newest);
	return groups;
}

function passesLens(g: Group, lens: Lens): boolean {
	switch (lens) {
		case "undoable": return !g.reverted;
		case "redoable": return g.reverted;
		case "committed": return g.committed;
		default: return true;
	}
}

export function EditHistoryPanel({ sessionId, loadEditHistory, onUndo, onRedo, onClose }: Props) {
	const [data, setData] = useState<EditHistoryData | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [lens, setLens] = useState<Lens>("all");
	const [filter, setFilter] = useState("");
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	// Pending undo/redo action state: which entry is in flight, and any notice.
	const [acting, setActing] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const refresh = useCallback(() => {
		let live = true;
		loadEditHistory(sessionId)
			.then(d => { if (live) setData(d); })
			.catch(e => {
				if (!live) return;
				const raw = e instanceof Error ? e.message : String(e);
				// External (CLI bridge) sessions used to not expose this; keep the
				// friendly copy for any residual unsupported error.
				setError(
					/unsupported_for_external|not supported/i.test(raw)
						? "Edit history is available for server-spawned sessions only."
						: raw,
				);
			});
		return () => { live = false; };
	}, [sessionId, loadEditHistory]);

	useEffect(() => {
		setData(null);
		setError(null);
		setNotice(null);
		return refresh();
	}, [refresh]);

	// Run an undo/redo, surface a declined notice, then refresh the list.
	async function act(kind: "undo" | "redo", entryId: string, force = false) {
		const fn = kind === "undo" ? onUndo : onRedo;
		if (!fn) return;
		setActing(entryId);
		setNotice(null);
		try {
			const data = (await fn(sessionId, entryId, force)) as { declined?: unknown; message?: string } | undefined;
			if (data && Array.isArray(data.declined) && data.declined.length > 0) {
				setNotice(`#${entryId} is already committed — use Force to revert anyway.`);
			} else if (data?.message) {
				setNotice(data.message);
			}
		} catch (e) {
			setNotice(e instanceof Error ? e.message : String(e));
		} finally {
			setActing(null);
			refresh();
		}
	}

	const groups = useMemo(() => {
		if (!data) return [];
		const f = filter.trim().toLowerCase();
		return groupEntries(data.entries)
			.filter(g => passesLens(g, lens))
			.filter(g => f.length === 0 || g.entries.some(e => e.file.toLowerCase().includes(f)));
	}, [data, lens, filter]);

	function toggle(groupId: string) {
		setExpanded(prev => {
			const next = new Set(prev);
			if (next.has(groupId)) next.delete(groupId);
			else next.add(groupId);
			return next;
		});
	}

	const lenses: Lens[] = ["all", "undoable", "redoable", "committed"];

	return (
		<aside className="hist-panel">
			<header className="hist-head">
				<span className="hist-title">Edit History</span>
				{data && <span className="hist-count">{data.undoable} undoable</span>}
				<button className="btn icon" onClick={onClose} title="Close" style={{ marginLeft: "auto" }}>✕</button>
			</header>

			<input className="hist-filter" placeholder="Filter by file…" value={filter} onChange={e => setFilter(e.target.value)} />

			<div className="hist-lenses">
				{lenses.map(l => (
					<button key={l} className={`hist-lens${lens === l ? " active" : ""}`} onClick={() => setLens(l)}>
						{l[0].toUpperCase() + l.slice(1)}
					</button>
				))}
			</div>

			{notice && <div className="hist-notice">{notice}</div>}

			<div className="hist-list">
				{error && <div className="hist-empty err">{error}</div>}
				{!error && !data && <div className="hist-empty muted">Loading…</div>}
				{data && groups.length === 0 && <div className="hist-empty muted">No edits match.</div>}
				{groups.map(g => {
					const multi = g.entries.length > 1;
					const open = expanded.has(g.groupId);
					const lead = g.entries[0];
					return (
						<div key={g.groupId} className={`hist-row${g.reverted ? " reverted" : ""}`}>
							<div className="hist-row-main" onClick={() => multi && toggle(g.groupId)} role={multi ? "button" : undefined}>
								<span className="hist-check" title={g.reverted ? "undone" : "applied"}>{g.reverted ? "↺" : "✓"}</span>
								<span className="hist-file">
									{multi ? `${open ? "▾" : "▸"} ${g.entries.length} files` : basename(lead.file)}
								</span>
								<span className="hist-tags">
									{multi && <span className="chip group">GROUP ×{g.entries.length}</span>}
									{g.committed && <span className="chip committed">COMMITTED</span>}
								</span>
								{(onUndo || onRedo) && (
									<span className="hist-actions" onClick={e => e.stopPropagation()}>
										{!g.reverted && onUndo && (
											<button className="hist-act" disabled={acting === lead.id} onClick={() => act("undo", lead.id, false)} title="Undo this edit">
												Undo
											</button>
										)}
										{!g.reverted && g.committed && onUndo && (
											<button className="hist-act force" disabled={acting === lead.id} onClick={() => act("undo", lead.id, true)} title="Force undo a committed edit">
												Force
											</button>
										)}
										{g.reverted && onRedo && (
											<button className="hist-act" disabled={acting === lead.id} onClick={() => act("redo", lead.id)} title="Redo this edit">
												Redo
											</button>
										)}
									</span>
								)}
							</div>
							<div className="hist-row-meta">
								<span className="chip ws">{shortWorkspace(g.workspace)}</span>
								{!multi && <span className="mono dim hist-dir">{lead.file.replace(basename(lead.file), "").replace(g.workspace, "").replace(/^\/+/, "")}</span>}
								<span className="dim">· {g.actor}</span>
								<span className="dim">· {ago(g.newest)}</span>
							</div>
							{multi && open && (
								<div className="hist-children">
									{g.entries.map(e => (
										<div key={e.id} className="hist-child">
											<span className="mono dim">#{e.id}</span>
											<span className="hist-file">{basename(e.file)}</span>
											{e.committed && <span className="chip committed">COMMITTED</span>}
										</div>
									))}
								</div>
							)}
						</div>
					);
				})}
			</div>

			<footer className="hist-foot dim small">✓ applied · ↺ undone — undo via the agent: <span className="mono">edit · undo · id</span></footer>
		</aside>
	);
}

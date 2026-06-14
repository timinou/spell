import { useState } from "react";
import { buildLensTarget, LENSES, type LensKind, nodeLocation } from "./code-lens";

export interface CodeQueryNode {
	kind: string;
	name?: string;
	path?: string;
	line?: number;
	text?: string;
}
export interface CodeQueryData {
	target: string;
	nodes: CodeQueryNode[];
	count: number;
}

interface Props {
	sessionId: string;
	runCodeQuery: (sessionId: string, target: string) => Promise<CodeQueryData>;
	onClose: () => void;
}

const MAX_RENDER = 200;

/**
 * Semantic code lens (FEAT-815 Phase C). Resolves CodePath targets through
 * pi-code-graph / LSP over the bridge: callers, definitions, implementers,
 * base types, hover types, outlines, diagnostics — for any live session.
 */
export function CodeLensPanel({ sessionId, runCodeQuery, onClose }: Props) {
	const [base, setBase] = useState("");
	const [data, setData] = useState<CodeQueryData | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [activeTarget, setActiveTarget] = useState<string | null>(null);

	async function run(target: string) {
		setBusy(true);
		setError(null);
		setActiveTarget(target);
		try {
			setData(await runCodeQuery(sessionId, target));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setData(null);
		} finally {
			setBusy(false);
		}
	}

	function runLens(kind: LensKind) {
		const target = buildLensTarget(base, kind);
		if (target) void run(target);
	}
	function runRaw() {
		const t = base.trim();
		if (t) void run(t);
	}

	const shown = data ? data.nodes.slice(0, MAX_RENDER) : [];

	return (
		<aside className="hist-panel">
			<header className="hist-head">
				<span className="hist-title">Code Lens</span>
				{data && <span className="hist-count">{data.count} nodes</span>}
				<button className="btn icon" onClick={onClose} title="Close" style={{ marginLeft: "auto" }}>
					✕
				</button>
			</header>

			<input
				className="hist-filter"
				placeholder="Symbol or path — e.g. src/foo.ts::Bar.method"
				value={base}
				onChange={e => setBase(e.target.value)}
				onKeyDown={e => {
					if (e.key === "Enter") runRaw();
				}}
			/>

			<div className="lens-chips">
				{LENSES.map(l => (
					<button key={l.kind} className="hist-lens" title={l.hint} disabled={!base.trim() || busy} onClick={() => runLens(l.kind)}>
						{l.label}
					</button>
				))}
			</div>

			{activeTarget && <div className="lens-target mono dim">{activeTarget}</div>}

			<div className="hist-list">
				{busy && <div className="hist-empty muted">Querying…</div>}
				{error && <div className="hist-empty err">{error}</div>}
				{!busy && !error && data && shown.length === 0 && <div className="hist-empty muted">No results.</div>}
				{!busy && !error && !data && <div className="hist-empty muted">Enter a target, then pick a lens.</div>}
				{shown.map((n, i) => (
					// eslint-disable-next-line react/no-array-index-key
					<div key={i} className="lens-row">
						<div className="lens-row-head">
							<span className="chip">{n.kind}</span>
							{n.name && <span className="hist-file">{n.name}</span>}
						</div>
						{n.path && <div className="mono dim lens-loc">{nodeLocation(n)}</div>}
						{n.text && <pre className="lens-text">{n.text.length > 280 ? `${n.text.slice(0, 280)}…` : n.text}</pre>}
					</div>
				))}
				{data && data.count > MAX_RENDER && (
					<div className="hist-empty muted">
						Showing first {MAX_RENDER} of {data.count}.
					</div>
				)}
			</div>

			<footer className="hist-foot dim small">Resolved via pi-code-graph + LSP over the live session.</footer>
		</aside>
	);
}

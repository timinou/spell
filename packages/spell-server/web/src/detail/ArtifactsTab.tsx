import { useEffect, useState } from "react";
import type { ArtifactRef } from "../api/client";
import type { DerivedSession } from "../state/sessions";

interface Props {
	session: DerivedSession;
	mintUrl: (sessionId: string, artifactPath: string, ttlSec?: number) => Promise<{ url: string; expiresAt: number }>;
	loadArtifacts: (sessionId: string) => Promise<ArtifactRef[]>;
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const PDF_EXTS = new Set([".pdf"]);

function artifactPathOf(ref: ArtifactRef): string {
	return `${ref.agent}/${ref.tool}/${ref.filename}`;
}

export function ArtifactsTab({ session, mintUrl, loadArtifacts }: Props) {
	const [selected, setSelected] = useState<ArtifactRef | null>(null);
	const [signedUrl, setSignedUrl] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [list, setList] = useState<ArtifactRef[]>(session.artifacts);

	useEffect(() => {
		setList(session.artifacts);
	}, [session.artifacts]);

	useEffect(() => {
		let cancelled = false;
		loadArtifacts(session.sessionId)
			.then(refs => {
				if (!cancelled) setList(prev => mergeArtifacts(prev, refs));
			})
			.catch(err => {
				if (!cancelled) setError(String(err));
			});
		return () => {
			cancelled = true;
		};
	}, [session.sessionId, loadArtifacts]);

	useEffect(() => {
		if (!selected) {
			setSignedUrl(null);
			return;
		}
		let cancelled = false;
		setError(null);
		mintUrl(session.sessionId, artifactPathOf(selected))
			.then(({ url }) => {
				if (!cancelled) setSignedUrl(url);
			})
			.catch(err => {
				if (!cancelled) setError(String(err));
			});
		return () => {
			cancelled = true;
		};
	}, [selected, session.sessionId, mintUrl]);

	const previewable = selected
		? IMAGE_EXTS.has(selected.ext) || PDF_EXTS.has(selected.ext)
		: false;

	return (
		<div className="pane" style={{ height: "100%" }}>
			<div className="artifact-list" style={{ height: "100%" }}>
				<div className="list">
					{list.length === 0 && <div className="muted">No artifacts yet.</div>}
					{list.map(ref => (
						<div
							key={ref.uri}
							className={`item${selected?.uri === ref.uri ? " active" : ""}`}
							onClick={() => setSelected(ref)}
						>
							<div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>{ref.filename}</div>
							<div className="muted" style={{ fontSize: 11 }}>
								{ref.agent}/{ref.tool} {"\u00b7"} {(ref.sizeBytes / 1024).toFixed(1)} KiB
							</div>
						</div>
					))}
				</div>
				<div className="viewer">
					{!selected && <div className="muted">Select an artifact.</div>}
					{selected && error && <div style={{ color: "var(--red)" }}>{error}</div>}
					{selected && signedUrl && previewable && PDF_EXTS.has(selected.ext) && (
						<iframe title={selected.filename} src={signedUrl} />
					)}
					{selected && signedUrl && previewable && IMAGE_EXTS.has(selected.ext) && (
						<img alt={selected.filename} src={signedUrl} />
					)}
					{selected && signedUrl && !previewable && (
						<a className="btn" href={`${signedUrl}&download=1`} download>
							Download {selected.filename}
						</a>
					)}
				</div>
			</div>
		</div>
	);
}

function mergeArtifacts(prev: ArtifactRef[], next: ArtifactRef[]): ArtifactRef[] {
	const seen = new Map(prev.map(a => [a.uri, a]));
	for (const ref of next) seen.set(ref.uri, ref);
	return [...seen.values()];
}

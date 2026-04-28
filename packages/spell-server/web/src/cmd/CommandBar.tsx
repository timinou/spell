import { Command } from "cmdk";
import { useEffect, useState } from "react";
import { useTemplates } from "../state/templates";
import { useSessions } from "../state/sessions";
import type { ManifestTemplate } from "../api/client";

export function CommandBar({
	onPickTemplate,
	onKillSession,
}: {
	onPickTemplate: (template: ManifestTemplate) => void;
	onKillSession: (sessionId: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const templates = useTemplates(s => s.templates);
	const sessions = useSessions(s => s.sessions);

	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				setOpen(prev => !prev);
				return;
			}
			if (e.key === "Escape" && open) setOpen(false);
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [open]);

	if (!open) return null;
	return (
		<div className="cmd-overlay" onClick={() => setOpen(false)}>
			<div className="cmd-panel" onClick={e => e.stopPropagation()}>
				<Command label="Spell command bar">
					<Command.Input placeholder="Search templates and sessions..." autoFocus />
					<Command.List className="cmd-list">
						<Command.Empty className="cmd-empty">No matches.</Command.Empty>
						{templates.length > 0 && (
							<Command.Group heading="Templates">
								{templates.map(t => (
									<Command.Item
										key={`tpl-${t.name}`}
										className="cmd-item"
										value={`run ${t.name}`}
										onSelect={() => {
											setOpen(false);
											onPickTemplate(t);
										}}
									>
										<span>{t.name}</span>
										<span className="muted">{t.description ?? "Run"}</span>
									</Command.Item>
								))}
							</Command.Group>
						)}
						{sessions.size > 0 && (
							<Command.Group heading="Sessions">
								{[...sessions.values()].map(s => (
									<Command.Item
										key={`kill-${s.sessionId}`}
										className="cmd-item"
										value={`kill ${s.sessionId} ${s.templateName ?? s.projectName}`}
										onSelect={() => {
											setOpen(false);
											onKillSession(s.sessionId);
										}}
									>
										<span>Kill {s.templateName ?? s.sessionId}</span>
										<span className="muted">{s.kind}</span>
									</Command.Item>
								))}
							</Command.Group>
						)}
					</Command.List>
				</Command>
			</div>
		</div>
	);
}

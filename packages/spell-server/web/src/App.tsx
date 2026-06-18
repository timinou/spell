import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ArtifactRef, type ManifestTemplate, type RpcSessionState, type SessionSummary } from "./api/client";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { Login } from "./auth/Login";
import { CommandBar } from "./cmd/CommandBar";
import { TemplateRunnerModal } from "./cmd/TemplateRunner";
import { SessionDetail } from "./detail/SessionDetail";
import { EditHistoryPanel } from "./detail/EditHistoryPanel";
import { CodeLensPanel } from "./detail/CodeLensPanel";
import { DisciplinesPanel } from "./detail/DisciplinesPanel";
import { SessionList } from "./sidebar/SessionList";
import { useSessions } from "./state/sessions";
import { useTemplates } from "./state/templates";
import { useToasts } from "./state/toasts";
import { buildWsUrl, SpellWsClient } from "./ws/client";

function ToastStack() {
	const toasts = useToasts(s => s.toasts);
	return (
		<div className="toast-stack">
			{toasts.map(t => (
				<div key={t.id} className={`toast ${t.kind}`}>
					{t.message}
				</div>
			))}
		</div>
	);
}

function Shell() {
	const { token, signOut } = useAuth();
	const wsRef = useRef<SpellWsClient | null>(null);
	const subsRef = useRef(new Map<string, Set<(event: { type: string }) => void>>());
	const correlationIdRef = useRef(0);
	const pendingResponses = useRef(new Map<string, (msg: any) => void>());
	const sessions = useSessions();
	const templates = useTemplates();
	const toasts = useToasts();
	const [pickedTemplate, setPickedTemplate] = useState<ManifestTemplate | null>(null);
	const [menuOpen, setMenuOpen] = useState(false);
	const [historyOpen, setHistoryOpen] = useState(false);
	const [lensOpen, setLensOpen] = useState(false);
	const [disciplinesOpen, setDisciplinesOpen] = useState(false);
	const selected = sessions.selected ? sessions.sessions.get(sessions.selected) ?? null : null;

	// On mobile the sidebar is a drawer; selecting a session closes it so the
	// detail view takes over the viewport.
	const selectedId = sessions.selected;
	useEffect(() => {
		setMenuOpen(false);
	}, [selectedId]);

	useEffect(() => {
		if (!token) return;
		const ws = new SpellWsClient({
			url: buildWsUrl(token),
			onMessage: msg => {
				// Subscribe to a session's live channels. Safe to call repeatedly: the
				// server only backfills the transcript when `events` is newly added, so
				// re-subscribing on every (re)connect does not duplicate history.
				const subscribeToSession = (summary: SessionSummary) => {
					if (summary.kind === "spawned") {
						ws.send({
							type: "subscribe",
							sessionId: summary.sessionId,
							channels: ["events", "artifacts", "state"],
							artifactExt: summary.watchExtensions,
						});
					} else {
						ws.send({ type: "subscribe", sessionId: summary.sessionId, channels: ["events", "artifacts"] });
					}
				};
				switch (msg.type) {
					case "session_list": {
						const list = msg.sessions as SessionSummary[];
						sessions.setAll(list);
						// On (re)connect — including a page refresh — subscribe to every
						// already-existing session so its live events + artifacts flow and
						// its recent transcript is backfilled. Without this, a refreshed
						// page sees the session in the list but receives nothing further.
						for (const summary of list) subscribeToSession(summary);
						break;
					}
					case "session_added": {
						const summary = msg.session as SessionSummary;
						sessions.upsert(summary);
						subscribeToSession(summary);
						break;
					}
					case "session_updated":
						sessions.upsert(msg.session as SessionSummary);
						break;
					case "session_removed":
						sessions.remove((msg.session as SessionSummary).sessionId);
						break;
					case "rpc_event": {
						const sessionId = msg.sessionId as string;
						const event = msg.event as { type: string };
						sessions.noteEvent(sessionId, event as any);
						const listeners = subsRef.current.get(sessionId);
						if (listeners) for (const l of listeners) l(event);
						break;
					}
					case "rpc_response": {
						const cid = msg.correlationId as string | undefined;
						if (cid && pendingResponses.current.has(cid)) {
							pendingResponses.current.get(cid)?.(msg);
							pendingResponses.current.delete(cid);
						}
						break;
					}
					case "external_event_log": {
						const sessionId = msg.sessionId as string;
						const entry = msg.entry as {
							kind: string;
							ts: number;
							text?: string;
							toolName?: string;
							meta?: Record<string, string | number | boolean>;
						};
						sessions.pushLog(sessionId, entry);
						break;
					}
					case "blocking_event": {
						sessions.setBlockingEvent(
							msg.sessionId as string,
							msg.payload as import("./api/client").BlockingEventPayload,
						);
						break;
					}
					case "blocking_event_cleared": {
						sessions.setBlockingEvent(msg.sessionId as string, undefined);
						break;
					}
					case "artifact_created": {
						const sessionId = msg.sessionId as string;
						const event = msg.artifact as { uri: string; agent: string; tool: string; filename: string; ext: string; sizeBytes: number };
						sessions.addArtifact(sessionId, {
							uri: event.uri,
							agent: event.agent,
							tool: event.tool,
							filename: event.filename,
							ext: event.ext,
							sizeBytes: event.sizeBytes,
						});
						const sess = sessions.sessions.get(sessionId);
						const exts = sess?.watchExtensions ?? [];
						if (exts.length === 0 || exts.includes(event.ext.toLowerCase())) {
							sessions.markReady(sessionId);
						}
						break;
					}
					case "artifact_url": {
						const cid = msg.correlationId as string | undefined;
						if (cid && pendingResponses.current.has(cid)) {
							pendingResponses.current.get(cid)?.(msg);
							pendingResponses.current.delete(cid);
						}
						break;
					}
					case "spawn_result": {
						const cid = msg.correlationId as string | undefined;
						if (cid && pendingResponses.current.has(cid)) {
							pendingResponses.current.get(cid)?.(msg);
							pendingResponses.current.delete(cid);
						}
						break;
					}
					case "error": {
						const cid = msg.correlationId as string | undefined;
						if (cid && pendingResponses.current.has(cid)) {
							pendingResponses.current.get(cid)?.(msg);
							pendingResponses.current.delete(cid);
						}
						toasts.push("error", `${(msg.code as string) ?? "error"}: ${msg.message ?? ""}`);
						break;
					}
				}
			},
			onStatus: status => {
				if (status === "auth_ok") {
					ws.send({ type: "list_sessions" });
				}
			},
		});
		wsRef.current = ws;
		// Initial template fetch over REST.
		api.listTemplates(token).then(({ templates: list }) => templates.setTemplates(list)).catch(() => {});
		return () => {
			ws.dispose();
			wsRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [token]);

	const subscribeRpcEvents = useCallback(
		(sessionId: string, listener: (event: { type: string }) => void) => {
			let set = subsRef.current.get(sessionId);
			if (!set) {
				set = new Set();
				subsRef.current.set(sessionId, set);
			}
			set.add(listener);
			return () => {
				set?.delete(listener);
			};
		},
		[],
	);

	function nextCid(): string {
		correlationIdRef.current += 1;
		return `c${correlationIdRef.current}`;
	}

	const submitPrompt = useCallback(
		async (sessionId: string, message: string, deliverAs?: "steer" | "followUp" | "auto") => {
			const cid = nextCid();
			const { promise, resolve } = Promise.withResolvers<unknown>();
			pendingResponses.current.set(cid, resolve);
			wsRef.current?.send({
				type: "rpc",
				sessionId,
				command: { type: "prompt", message },
				deliverAs,
				correlationId: cid,
			});
			await promise;
		},
		[],
	);

	const abort = useCallback(async (sessionId: string) => {
		wsRef.current?.send({ type: "rpc", sessionId, command: { type: "abort" } });
	}, []);

	// Fetch the session's unified edit-history log (PLAN-338) over RPC. Resolves
	// with the typed payload or throws on an error response.
	const requestEditHistory = useCallback(
		async (sessionId: string, file?: string): Promise<import("./api/client").EditHistoryData> => {
			const cid = nextCid();
			const { promise, resolve } = Promise.withResolvers<any>();
			pendingResponses.current.set(cid, resolve);
			wsRef.current?.send({ type: "rpc", sessionId, command: { type: "edit_history", file }, correlationId: cid });
			const msg = await promise;
			const response = msg?.response;
			if (response && response.success === false) throw new Error(response.error ?? "edit_history failed");
			return (response?.data ?? { entries: [], total: 0, undoable: 0, redoable: 0 }) as import("./api/client").EditHistoryData;
		},
		[],
	);

	// FEAT-815: undo/redo a recorded edit + run a semantic code query, all over
	// the same correlationId round-trip. For external sessions these are proxied
	// to the CLI agent's kernel via the duplex bridge frame.
	const sendRpc = useCallback(async (sessionId: string, command: Record<string, unknown>): Promise<unknown> => {
		const cid = nextCid();
		const { promise, resolve } = Promise.withResolvers<any>();
		pendingResponses.current.set(cid, resolve);
		wsRef.current?.send({ type: "rpc", sessionId, command, correlationId: cid });
		const msg = await promise;
		const response = msg?.response;
		if (response && response.success === false) throw new Error(response.error ?? `${command.type} failed`);
		return response?.data;
	}, []);

	const requestUndo = useCallback(
		(sessionId: string, entryId?: string, force?: boolean) =>
			sendRpc(sessionId, { type: "undo", entryId, force }),
		[sendRpc],
	);
	const requestRedo = useCallback(
		(sessionId: string, entryId?: string) => sendRpc(sessionId, { type: "redo", entryId }),
		[sendRpc],
	);
	const refreshDisciplineStats = useCallback(
		async (sessionId: string) => {
			try {
				const state = (await sendRpc(sessionId, { type: "get_state" })) as RpcSessionState;
				sessions.setDisciplineStats(sessionId, state.disciplineStats ?? null);
			} catch (err) {
				console.warn("discipline get_state failed", err);
			}
		},
		[sendRpc, sessions],
	);
	const requestCodeQuery = useCallback(
		(sessionId: string, target: string) =>
			sendRpc(sessionId, { type: "code_query", target }) as Promise<import("./detail/CodeLensPanel").CodeQueryData>,
		[sendRpc],
	);

	const answerBlockingEvent = useCallback(
		(sessionId: string, eventId: string, payload: import("./api/client").EventResponsePayload) => {
			wsRef.current?.send({ type: "answer_blocking_event", sessionId, eventId, payload });
			sessions.setBlockingEvent(sessionId, undefined);
		},
		[sessions],
	);

	const runBash = useCallback(async () => {
		// RPC bash is not exposed as a top-level command in BridgeRpcCommand v1;
		// fall back to surfacing a friendly message until backend extends RPC.
		throw new Error("Bash RPC requires server upgrade — track FUP for `bash` command");
	}, []);

	const mintUrl = useCallback(async (sessionId: string, artifactPath: string, ttlSec = 300) => {
		if (!token) throw new Error("not authenticated");
		return api.mintArtifactUrl(token, sessionId, artifactPath, ttlSec);
	}, [token]);

	const loadArtifacts = useCallback(async (sessionId: string) => {
		if (!token) return [];
		const { artifacts } = await api.listArtifacts(token, sessionId);
		return artifacts;
	}, [token]);

	const onPickTemplate = useCallback((template: ManifestTemplate) => {
		setPickedTemplate(template);
	}, []);

	const onKillSession = useCallback(async (sessionId: string) => {
		wsRef.current?.send({ type: "kill", sessionId });
		sessions.remove(sessionId);
		toasts.push("info", `Killed ${sessionId}`);
	}, [sessions, toasts]);

	const submitTemplate = useCallback(
		async (params: Record<string, unknown>) => {
			if (!pickedTemplate || !token) return;
			try {
				const result = await api.runTemplate(token, pickedTemplate.name, params);
				toasts.push("info", `Spawned session ${result.sessionId}`);
				setPickedTemplate(null);
				sessions.select(result.sessionId);
			} catch (err) {
				toasts.push("error", `Run failed: ${String(err)}`);
				throw err;
			}
		},
		[pickedTemplate, token, toasts, sessions],
	);

	const sessionDetail = useMemo(() => {
		if (!selected) {
			return (
				<div className="main">
					<div className="pane muted" style={{ display: "grid", placeItems: "center" }}>
						Select a session in the sidebar, or press Cmd+K to launch a template.
					</div>
				</div>
			);
		}
		return (
			<SessionDetail
				session={selected}
				subscribeRpcEvents={subscribeRpcEvents}
				submitPrompt={submitPrompt}
				abort={abort}
				answerBlockingEvent={answerBlockingEvent}
				runBash={runBash}
				mintUrl={mintUrl}
				loadArtifacts={loadArtifacts}
			/>
		);
	}, [selected, subscribeRpcEvents, submitPrompt, abort, answerBlockingEvent, runBash, mintUrl, loadArtifacts]);

	return (
		<div className={`shell${menuOpen ? " menu-open" : ""}${(historyOpen || lensOpen || disciplinesOpen) && selected ? " has-history" : ""}`}>
			<aside className="sidebar">
				<header>
 				<h1>Spell</h1>
 					<div style={{ display: "flex", gap: 6 }}>
 						{selected && (
 							<button
 								className={`btn${historyOpen ? " btn-primary" : ""}`}
 								onClick={() => {
 									setHistoryOpen(o => !o);
 									setLensOpen(false);
 								}}
 								title="Edit history — every file this session changed"
 							>
 								History
 							</button>
 						)}
  					{selected && (
  						<button
  							className={`btn${lensOpen ? " btn-primary" : ""}`}
  							onClick={() => {
  								setLensOpen(o => !o);
  								setHistoryOpen(false);
  								setDisciplinesOpen(false);
  							}}
  							title="Code lens — callers, defs, types, diagnostics via pi-code-graph"
  						>
  							Lens
  						</button>
  					)}
  					{selected && (
  						<button
  							className={`btn${disciplinesOpen ? " btn-primary" : ""}`}
  							onClick={() => {
  								setDisciplinesOpen(o => {
  									const next = !o;
  									if (next) void refreshDisciplineStats(selected.sessionId);
  									return next;
  								});
  								setHistoryOpen(false);
  								setLensOpen(false);
  							}}
  							title="Armed discipline stats and yield outcomes"
  						>
  							Disciplines
  						</button>
  					)}
  					<button className="btn" onClick={signOut} title="Sign out">
  						Sign out
  					</button>
 					</div>
				</header>
				<SessionList />
			</aside>
			{/* Mobile-only: scrim closes the session drawer. */}
			<div className="drawer-scrim" onClick={() => setMenuOpen(false)} aria-hidden="true" />
			<div className="main-wrap">
				<div className="mobile-topbar">
					<button className="btn icon" onClick={() => setMenuOpen(o => !o)} aria-label="Toggle sessions">
						☰
					</button>
					<span className="mobile-title">{selected ? selected.projectName : "Spell"}</span>
				</div>
				{sessionDetail}
			</div>
			{historyOpen && selected && (
				<EditHistoryPanel
					sessionId={selected.sessionId}
					loadEditHistory={requestEditHistory}
					onUndo={requestUndo}
					onRedo={requestRedo}
					onClose={() => setHistoryOpen(false)}
				/>
			)}
			{lensOpen && selected && (
				<CodeLensPanel
					sessionId={selected.sessionId}
					runCodeQuery={requestCodeQuery}
					onClose={() => setLensOpen(false)}
				/>
			)}
			{disciplinesOpen && selected && (
				<DisciplinesPanel
					sessionId={selected.sessionId}
					disciplineStats={selected.disciplineStats || null}
					lastOutcomes={selected.lastDisciplineOutcomes || null}
					onClose={() => setDisciplinesOpen(false)}
				/>
			)}
			<CommandBar onPickTemplate={onPickTemplate} onKillSession={onKillSession} />
			{pickedTemplate && (
				<TemplateRunnerModal
					template={pickedTemplate}
					onSubmit={submitTemplate}
					onCancel={() => setPickedTemplate(null)}
				/>
			)}
			<ToastStack />
		</div>
	);
}

function AuthGate() {
	const { status } = useAuth();
	if (status === "ok") return <Shell />;
	return <Login />;
}

export function App() {
	return (
		<AuthProvider>
			<AuthGate />
		</AuthProvider>
	);
}

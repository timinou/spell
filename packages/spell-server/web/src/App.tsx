import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ArtifactRef, type ManifestTemplate, type SessionSummary } from "./api/client";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { Login } from "./auth/Login";
import { CommandBar } from "./cmd/CommandBar";
import { TemplateRunnerModal } from "./cmd/TemplateRunner";
import { SessionDetail } from "./detail/SessionDetail";
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
	const selected = sessions.selected ? sessions.sessions.get(sessions.selected) ?? null : null;

	useEffect(() => {
		if (!token) return;
		const ws = new SpellWsClient({
			url: buildWsUrl(token),
			onMessage: msg => {
				switch (msg.type) {
					case "session_list": {
						sessions.setAll(msg.sessions as SessionSummary[]);
						break;
					}
					case "session_added": {
						sessions.upsert(msg.session as SessionSummary);
						const summary = msg.session as SessionSummary;
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
						const entry = msg.entry as { kind: string; ts: number; text?: string; toolName?: string };
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
		<div className="shell">
			<aside className="sidebar">
				<header>
					<h1>Spell</h1>
					<button className="btn" onClick={signOut} title="Sign out">
						Sign out
					</button>
				</header>
				<SessionList />
			</aside>
			{sessionDetail}
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

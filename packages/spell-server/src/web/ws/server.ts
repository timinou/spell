import { logger } from "@spell/pi-utils";
import type { Server, WebSocketHandler } from "bun";
import type { SpellServerConfig } from "../../config/types";
import { verifyWebToken } from "../../http/auth";
import type { AutonomyManifest } from "../../manifest/types";
import type { SessionRegistryEntry, SocketSessionRegistry } from "../../socket/session-registry";
import type { EventLogEntry } from "../../socket/types";
import { mintSignedArtifactUrl } from "../artifacts/signed-url";
import type { ArtifactCreatedEvent } from "../artifacts/types";
import type { ArtifactWatcher } from "../artifacts/watcher";
import type { WebSessionHub } from "../session/web-session-hub";
import { MissingParamError, ParamCoercionError, UnknownParamError } from "../templates/params";
import type { TemplateRunner } from "../templates/runner";
import { WebConnection, type WebConnectionData } from "./connection";
import { type Channel, isWsClientMessage, type SessionSummary, type WsClientMessage } from "./protocol";

export interface WebRoutesDeps {
	server: SpellServerConfig;
	signingKey: Buffer;
	registry: SocketSessionRegistry;
	hub: WebSessionHub;
	watcher: ArtifactWatcher;
	templateRunner: TemplateRunner;
	manifest: AutonomyManifest;
}

function entryToSummary(entry: SessionRegistryEntry): SessionSummary {
	return {
		sessionId: entry.sessionId,
		kind: entry.kind,
		pid: entry.pid,
		cwd: entry.cwd,
		mode: entry.mode,
		startedAt: entry.startedAt,
		projectName: entry.projectName,
		lastHeartbeat: entry.lastHeartbeat,
		currentBlockingEvent: entry.currentBlockingEvent,
		ownedBy: entry.ownedBy,
		templateName: entry.templateName,
		watchExtensions: entry.watchExtensions,
	};
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(value), {
		...init,
		headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
	});
}

export class WebSubsystem {
	#deps: WebRoutesDeps;
	#connections = new Set<WebConnection>();
	#fanoutsRegistered = false;

	constructor(deps: WebRoutesDeps) {
		this.#deps = deps;
	}

	connections(): readonly WebConnection[] {
		return [...this.#connections];
	}

	registerFanout(): void {
		if (this.#fanoutsRegistered) return;
		this.#fanoutsRegistered = true;

		this.#deps.registry.onSessionChange((type, sessionId) => {
			const entry = this.#deps.registry.getSession(sessionId);
			if (type === "registered" && entry) {
				const summary = entryToSummary(entry);
				for (const c of this.#connections) c.send({ type: "session_added", session: summary });
				return;
			}
			if (type === "deregistered") {
				const summary: SessionSummary = entry
					? entryToSummary(entry)
					: {
							sessionId,
							kind: "external",
							pid: -1,
							cwd: "",
							mode: "",
							startedAt: 0,
							projectName: "",
							lastHeartbeat: 0,
						};
				for (const c of this.#connections) c.send({ type: "session_removed", session: summary });
			}
		});

		this.#deps.registry.onBlockingEvent((sessionId, payload) => {
			for (const c of this.#connections) {
				if (c.wants(sessionId, "events")) {
					c.send({ type: "blocking_event", sessionId, payload });
				}
			}
		});

		this.#deps.registry.onEventLog((sessionId, entry: EventLogEntry) => {
			for (const c of this.#connections) {
				if (c.wants(sessionId, "events")) {
					c.send({ type: "external_event_log", sessionId, entry });
				}
			}
		});

		this.#deps.hub.onLifecycle(event => {
			const entry = this.#deps.registry.getSession(event.sessionId);
			if (!entry) return;
			const summary = entryToSummary(entry);
			for (const c of this.#connections) {
				if (event.type === "session_added") c.send({ type: "session_added", session: summary });
				else if (event.type === "session_updated") c.send({ type: "session_updated", session: summary });
			}
		});

		this.#deps.watcher.onCreated((event: ArtifactCreatedEvent) => {
			for (const c of this.#connections) {
				if (c.wantsArtifact(event.sessionId, event)) {
					c.send({ type: "artifact_created", sessionId: event.sessionId, artifact: event });
				}
			}
		});

		this.#deps.hub.onProcessInfo(sample => {
			for (const c of this.#connections) {
				if (c.wants(sample.sessionId, "state")) {
					c.send({
						type: "process_info",
						sessionId: sample.sessionId,
						pid: sample.pid,
						rssBytes: sample.rssBytes,
						cpuPercent: sample.cpuPercent,
						uptimeMs: sample.uptimeMs,
						ts: sample.ts,
					});
				}
			}
		});
	}

	// ---- HTTP REST router -------------------------------------------------

	async handleRest(request: Request): Promise<Response | null> {
		const url = new URL(request.url);
		if (!url.pathname.startsWith("/web/api/")) return null;
		const identity = verifyWebToken(request, this.#deps.server.web);
		if (!identity) return new Response("Unauthorized", { status: 401 });

		const segments = url.pathname.split("/").filter(Boolean);
		// /web/api/sessions
		if (segments[2] === "sessions") {
			if (segments.length === 3 && request.method === "GET") {
				const sessions = this.#deps.registry.getAll().map(entryToSummary);
				return jsonResponse({ sessions });
			}
			const sessionId = segments[3];
			if (!sessionId) return jsonResponse({ error: "session id required" }, { status: 400 });
			if (segments.length === 4 && request.method === "GET") {
				const entry = this.#deps.registry.getSession(sessionId);
				if (!entry) return jsonResponse({ error: "not found" }, { status: 404 });
				return jsonResponse(entryToSummary(entry));
			}
			if (segments.length === 4 && request.method === "DELETE") {
				try {
					await this.#deps.hub.kill(sessionId);
					return new Response(null, { status: 204 });
				} catch (error) {
					return jsonResponse({ error: String(error) }, { status: 500 });
				}
			}
			if (segments.length === 5 && segments[4] === "artifacts" && request.method === "GET") {
				const root = this.#deps.hub.getSessionRoot(sessionId);
				if (!root) return jsonResponse({ artifacts: [] });
				const artifacts = await listArtifactsInRoot(sessionId, root);
				return jsonResponse({ artifacts });
			}
			if (
				segments.length === 6 &&
				segments[4] === "artifacts" &&
				segments[5] === "url" &&
				request.method === "POST"
			) {
				const body = (await request.json().catch(() => ({}))) as { artifactPath?: string; ttlSec?: number };
				if (!body.artifactPath) return jsonResponse({ error: "artifactPath required" }, { status: 400 });
				const ttl = Math.min(60 * 60, Math.max(5, body.ttlSec ?? 300));
				const safe = `/web/artifacts/${encodeURIComponent(sessionId)}/${body.artifactPath
					.split("/")
					.map(encodeURIComponent)
					.join("/")}`;
				const url = mintSignedArtifactUrl(safe, ttl, this.#deps.signingKey);
				return jsonResponse({ url, expiresAt: Date.now() + ttl * 1000 });
			}
		}
		// /web/api/templates
		if (segments[2] === "templates") {
			if (segments.length === 3 && request.method === "GET") {
				const templates = [...this.#deps.manifest.templates.values()];
				return jsonResponse({ templates });
			}
			if (segments.length === 5 && segments[4] === "run" && request.method === "POST") {
				const name = segments[3];
				if (!name) return jsonResponse({ error: "template name required" }, { status: 400 });
				const body = (await request.json().catch(() => ({}))) as { params?: Record<string, unknown> };
				try {
					const result = await this.#deps.templateRunner.runTemplate(name, body.params ?? {}, identity);
					return jsonResponse(result, { status: 201 });
				} catch (error) {
					if (
						error instanceof MissingParamError ||
						error instanceof UnknownParamError ||
						error instanceof ParamCoercionError
					) {
						return jsonResponse({ error: error.message, code: error.name }, { status: 400 });
					}
					logger.warn("template run failed", { template: name, error: String(error) });
					return jsonResponse({ error: String(error) }, { status: 500 });
				}
			}
		}
		return jsonResponse({ error: "not found" }, { status: 404 });
	}

	// ---- WebSocket handling ----------------------------------------------

	tryUpgrade(request: Request, server: Server<WebConnectionData>): boolean {
		const url = new URL(request.url);
		if (url.pathname !== "/web/ws") return false;
		const identity = verifyWebToken(request, this.#deps.server.web);
		if (!identity) return false;
		return server.upgrade(request, { data: { identity } satisfies WebConnectionData });
	}

	websocketHandler(): WebSocketHandler<WebConnectionData> {
		const subsystem = this;
		return {
			open(ws) {
				const connection = new WebConnection(ws, ws.data.identity);
				subsystem.#connections.add(connection);
				(ws as unknown as { _spellWebConn?: WebConnection })._spellWebConn = connection;
				connection.send({ type: "auth_ok", identity: { name: ws.data.identity.name } });
			},
			close(ws) {
				const connection = (ws as unknown as { _spellWebConn?: WebConnection })._spellWebConn;
				if (!connection) return;
				connection.dispose();
				subsystem.#connections.delete(connection);
			},
			async message(ws, raw) {
				const connection = (ws as unknown as { _spellWebConn?: WebConnection })._spellWebConn;
				if (!connection) return;
				const text = typeof raw === "string" ? raw : raw.toString("utf8");
				let parsed: unknown;
				try {
					parsed = JSON.parse(text);
				} catch {
					connection.send({ type: "error", code: "bad_json", message: "invalid JSON" });
					return;
				}
				if (!isWsClientMessage(parsed)) {
					connection.send({ type: "error", code: "bad_message", message: "missing type" });
					return;
				}
				await subsystem.#dispatch(connection, parsed);
			},
		};
	}

	async #dispatch(connection: WebConnection, msg: WsClientMessage): Promise<void> {
		const correlationId = msg.correlationId;
		try {
			switch (msg.type) {
				case "ping":
					connection.send({ type: "pong", correlationId });
					return;
				case "list_sessions": {
					const sessions = this.#deps.registry.getAll().map(entryToSummary);
					connection.send({ type: "session_list", sessions, correlationId });
					return;
				}
				case "subscribe": {
					// Only backfill the transcript when `events` is newly added to this
					// connection's subscription, so a redundant resubscribe does not
					// replay (and duplicate) the ring buffer on the operator's view.
					const eventsAlreadySubscribed = connection.wants(msg.sessionId, "events");
					connection.subscribe(msg.sessionId, msg.channels as Channel[], msg.artifactExt);
					if (msg.channels.includes("events")) {
						// Backfill the recent terminal transcript so a freshly-opened web
						// session shows context immediately, then stream live updates.
						const entry = this.#deps.registry.getSession(msg.sessionId);
						if (!eventsAlreadySubscribed && entry?.kind === "external") {
							for (const recent of this.#deps.registry.getRecentLog(msg.sessionId)) {
								connection.send({ type: "external_event_log", sessionId: msg.sessionId, entry: recent });
							}
						}
						this.#tapEvents(connection, msg.sessionId);
					}
					if (msg.channels.includes("debug")) this.#tapStderr(connection, msg.sessionId);
					return;
				}
				case "unsubscribe":
					connection.unsubscribe(msg.sessionId, msg.channels as Channel[] | undefined);
					return;
				case "rpc": {
					const entry = this.#deps.registry.getSession(msg.sessionId);
					if (entry?.kind === "external") {
						await this.#dispatchExternalRpc(connection, msg, entry, correlationId);
						return;
					}
					try {
						const response = await this.#deps.hub.send(msg.sessionId, msg.command);
						connection.send({ type: "rpc_response", sessionId: msg.sessionId, response, correlationId });
					} catch (error) {
						connection.send({
							type: "error",
							code: "rpc_failed",
							message: String(error),
							correlationId,
						});
					}
					return;
				}
				case "answer_blocking_event": {
					const entry = this.#deps.registry.getSession(msg.sessionId);
					if (!entry) {
						connection.send({ type: "error", code: "unknown_session", message: msg.sessionId, correlationId });
						return;
					}
					if (entry.kind === "spawned") {
						connection.send({
							type: "error",
							code: "not_supported_for_spawned",
							message: "spawned sessions cannot answer blocking events",
							correlationId,
						});
						return;
					}
					this.#deps.registry.resolveEvent(msg.sessionId, msg.eventId, msg.payload);
					return;
				}
				case "spawn": {
					try {
						if (msg.templateName) {
							const result = await this.#deps.templateRunner.runTemplate(
								msg.templateName,
								msg.params ?? {},
								connection.identity,
							);
							connection.send({ type: "spawn_result", sessionId: result.sessionId, correlationId });
							return;
						}
						if (!msg.cwd) {
							connection.send({
								type: "error",
								code: "missing_cwd",
								message: "spawn requires either templateName or cwd",
								correlationId,
							});
							return;
						}
						// Raw chat spawn: minimal BaseSpawnOptions with no setup constraints,
						// then fire initialPrompt as the first prompt command if provided.
						const { sessionId } = await this.#deps.hub.spawn({
							ownedBy: connection.identity.name,
							mode: msg.mode ?? "rpc",
							base: { cwd: msg.cwd, tools: [] },
						});
						// Ack the spawn immediately so the UI can switch over. The initial
						// prompt is fire-and-forget: its response will arrive as a normal
						// rpc_event stream, no need to block spawn_result on it.
						connection.send({ type: "spawn_result", sessionId, correlationId });
						if (msg.initialPrompt && msg.initialPrompt.trim().length > 0) {
							void this.#deps.hub.send(sessionId, { type: "prompt", message: msg.initialPrompt }).catch(error => {
								logger.warn("raw spawn: initial prompt send failed", { sessionId, error: String(error) });
							});
						}
					} catch (error) {
						connection.send({ type: "error", code: "spawn_failed", message: String(error), correlationId });
					}
					return;
				}
				case "kill":
					await this.#deps.hub.kill(msg.sessionId);
					return;
				case "mint_artifact_url": {
					const ttl = Math.min(60 * 60, Math.max(5, msg.ttlSec ?? 300));
					const safe = `/web/artifacts/${encodeURIComponent(msg.sessionId)}/${msg.artifactPath
						.split("/")
						.map(encodeURIComponent)
						.join("/")}`;
					const url = mintSignedArtifactUrl(safe, ttl, this.#deps.signingKey);
					connection.send({
						type: "artifact_url",
						sessionId: msg.sessionId,
						url,
						expiresAt: Date.now() + ttl * 1000,
						correlationId,
					});
					return;
				}
			}
		} catch (error) {
			logger.warn("ws dispatch failed", { error: String(error) });
			connection.send({ type: "error", code: "internal", message: String(error), correlationId });
		}
	}

	/**
	 * Steer an external (terminal/TUI) session. Only `prompt` is supported today
	 * — it is injected over the bridge socket as a real user turn. Other RPC
	 * commands have no external transport yet and are rejected truthfully.
	 */
	async #dispatchExternalRpc(
		connection: WebConnection,
		msg: Extract<WsClientMessage, { type: "rpc" }>,
		entry: SessionRegistryEntry,
		correlationId: string | undefined,
	): Promise<void> {
		if (msg.command.type !== "prompt") {
			connection.send({
				type: "rpc_response",
				sessionId: msg.sessionId,
				response: {
					type: "response",
					command: msg.command.type,
					success: false,
					error: "unsupported_for_external",
				},
				correlationId,
			});
			return;
		}
		const result = await this.#deps.registry.injectMessage(msg.sessionId, {
			text: msg.command.message,
			deliverAs: msg.deliverAs ?? "auto",
		});
		connection.send({
			type: "rpc_response",
			sessionId: msg.sessionId,
			response: result.accepted
				? { type: "response", command: "prompt", success: true, data: { injected: true } }
				: { type: "response", command: "prompt", success: false, error: result.reason ?? "rejected" },
			correlationId,
		});
	}

	#tapEvents(connection: WebConnection, sessionId: string): void {
		try {
			const unsub = this.#deps.hub.subscribeEvents(sessionId, event => {
				if (!connection.wants(sessionId, "events")) return;
				if (event.type === "response") return;
				connection.send({ type: "rpc_event", sessionId, event });
			});
			connection.registerTap(sessionId, "events", unsub);
		} catch {
			// Spawned session may have ended; silent
		}
	}

	#tapStderr(connection: WebConnection, sessionId: string): void {
		try {
			const unsub = this.#deps.hub.subscribeStderr(sessionId, line => {
				if (!connection.wants(sessionId, "debug")) return;
				connection.send({ type: "rpc_stderr", sessionId, line, ts: Date.now() });
			});
			connection.registerTap(sessionId, "debug", unsub);
		} catch {
			// External session or already ended; silent (debug is best-effort)
		}
	}
}

async function listArtifactsInRoot(
	sessionId: string,
	rootDir: string,
): Promise<Array<{ uri: string; agent: string; tool: string; filename: string; sizeBytes: number; ext: string }>> {
	const fs = await import("node:fs/promises");
	const path = await import("node:path");
	const out: Array<{ uri: string; agent: string; tool: string; filename: string; sizeBytes: number; ext: string }> =
		[];
	let agents: string[];
	try {
		agents = await fs.readdir(rootDir);
	} catch {
		return out;
	}
	for (const agent of agents) {
		const agentDir = path.join(rootDir, agent);
		let tools: string[];
		try {
			tools = await fs.readdir(agentDir);
		} catch {
			continue;
		}
		for (const tool of tools) {
			const toolDir = path.join(agentDir, tool);
			let files: string[];
			try {
				files = await fs.readdir(toolDir);
			} catch {
				continue;
			}
			for (const filename of files) {
				if (filename.startsWith(".")) continue;
				let stat: import("node:fs").Stats;
				try {
					stat = await fs.stat(path.join(toolDir, filename));
				} catch {
					continue;
				}
				if (!stat.isFile()) continue;
				out.push({
					uri: `artifact://${sessionId}/${agent}/${tool}/${filename}`,
					agent,
					tool,
					filename,
					sizeBytes: stat.size,
					ext: path.extname(filename).toLowerCase(),
				});
			}
		}
	}
	return out;
}

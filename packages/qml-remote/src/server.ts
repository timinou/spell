import { logger } from "@oh-my-pi/pi-utils";
import type { Server, ServerWebSocket } from "bun";
import type { ClientPanelMessage } from "./protocol";
import { RemoteQmlBridge } from "./remote-bridge";

export interface QmlRemoteServerOptions {
	port: number;
	/** Called when the Android client sends an RPC command (e.g. prompt, abort). */
	onRpcCommand?: (cmd: unknown) => void;
}

type ConnectionEvent = "connected" | "disconnected";
type ConnectionListener = () => void;

/**
 * WebSocket server that bridges the coding-agent RPC protocol and QML panel
 * push protocol to a single Android client.
 *
 * Only one concurrent client is supported. When a new connection arrives,
 * the previous one is dropped and the transport is re-assigned.
 */
export class QmlRemoteServer {
	readonly #options: QmlRemoteServerOptions;
	readonly #bridge: RemoteQmlBridge;
	readonly #listeners = new Map<ConnectionEvent, Set<ConnectionListener>>();

	// Active server instance (set by start())
	#server: Server<unknown> | null = null;
	// Current WebSocket connection (null when no client)
	#ws: ServerWebSocket<unknown> | null = null;

	constructor(options: QmlRemoteServerOptions) {
		this.#options = options;
		this.#bridge = new RemoteQmlBridge();
	}

	get bridge(): RemoteQmlBridge {
		return this.#bridge;
	}

	/** Push an RPC event to the connected client. */
	sendRpcEvent(event: unknown): void {
		if (!this.#ws) {
			logger.warn("QmlRemoteServer.sendRpcEvent: no client connected");
			return;
		}
		this.#ws.send(JSON.stringify({ channel: "rpc_event", data: event }));
	}

	/** Register a listener for connection lifecycle events. Returns a remove fn. */
	addListener(event: ConnectionEvent, fn: ConnectionListener): () => void {
		let set = this.#listeners.get(event);
		if (!set) {
			set = new Set();
			this.#listeners.set(event, set);
		}
		set.add(fn);
		return () => set!.delete(fn);
	}

	/** Start the WebSocket server. Returns the server URL. */
	start(): string {
		if (this.#server) return `ws://localhost:${this.#options.port}`;

		// Keep a reference to the outer instance for use inside WebSocket handlers.
		const self = this;

		this.#server = Bun.serve({
			port: this.#options.port,

			fetch(req, server) {
				const url = new URL(req.url);
				if (url.pathname === "/ws" && server.upgrade(req, { data: undefined })) {
					// upgrade() returns true — Bun will call websocket.open
					return undefined;
				}
				return new Response("Not found", { status: 404 });
			},

			websocket: {
				open(ws) {
					// Drop previous connection — last client wins
					if (self.#ws) {
						logger.warn("QmlRemoteServer: dropping previous connection");
						self.#ws.close();
					}
					self.#ws = ws;
					self.#bridge._setTransport(msg => {
						ws.send(JSON.stringify({ channel: "panel", data: msg }));
					});
					logger.debug("QmlRemoteServer: client connected");
					self.#emit("connected");
				},

				message(_ws, raw) {
					const text = typeof raw === "string" ? raw : raw.toString("utf8");
					let parsed: unknown;
					try {
						parsed = JSON.parse(text);
					} catch (err) {
						logger.warn("QmlRemoteServer: invalid JSON from client", { err });
						return;
					}

					if (!isObject(parsed) || typeof parsed.channel !== "string") {
						logger.warn("QmlRemoteServer: message missing channel", { parsed });
						return;
					}

					switch (parsed.channel) {
						case "panel": {
							const msg = parsed.data as ClientPanelMessage;
							self.#bridge._deliverClientMessage(msg);
							break;
						}
						case "rpc": {
							const cmd = parsed.data;
							self.#options.onRpcCommand?.(cmd);
							break;
						}
						default:
							logger.warn("QmlRemoteServer: unknown channel", { channel: parsed.channel });
					}
				},

				close(ws, code, reason) {
					// Only handle if this is the current connection
					if (self.#ws !== ws) return;
					self.#ws = null;
					self.#bridge._clearTransport();
					logger.debug("QmlRemoteServer: client disconnected", { code, reason });
					self.#emit("disconnected");
				},
			},
		});

		const url = `ws://localhost:${this.#options.port}/ws`;
		logger.debug("QmlRemoteServer: started", { url });
		return url;
	}

	/** Stop the WebSocket server. */
	stop(): void {
		if (!this.#server) return;
		this.#server.stop(true);
		this.#server = null;
		this.#ws = null;
		this.#bridge._clearTransport();
		logger.debug("QmlRemoteServer: stopped");
	}

	#emit(event: ConnectionEvent): void {
		const set = this.#listeners.get(event);
		if (!set) return;
		for (const fn of set) fn();
	}
}

// ---------------------------------------------------------------------------
// Internal type guard
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

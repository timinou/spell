import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import {
	type BlockingEventPayload,
	EVENT_LOG_ENTRY_KINDS,
	type EventLogEntry,
	type EventResponsePayload,
	type SocketClientMessage,
	type SocketServerMessage,
} from "./types";

const EVENT_LOG_TEXT_MAX = 256;

const DEFAULT_SOCKET_RELATIVE_PATH = ".spell/server.sock";
const HEARTBEAT_INTERVAL_MS = 30_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000] as const;

type PendingEvent = {
	resolve: (payload: EventResponsePayload | null) => void;
};

export interface SessionBridgeOptions {
	socketPath?: string;
	sessionId: string;
	pid: number;
	cwd: string;
	mode: string;
	startedAt: number;
	projectName: string;
	/**
	 * Opt in to forwarding low-fi summary events (`turn_start`, `tool_call`,
	 * `assistant_text`, ...) to the bridge. Default off so external CLI sessions
	 * never leak content unintentionally.
	 */
	eventLog?: boolean;
}

function isErrorWithCode(value: unknown): value is Error & { code?: string } {
	return value instanceof Error;
}

function isSocketServerMessage(value: unknown): value is SocketServerMessage {
	return typeof value === "object" && value !== null && "type" in value && "timestamp" in value;
}

export class SessionBridgeClient {
	#socket: net.Socket | null = null;
	#connected = false;
	readonly #options: SessionBridgeOptions;
	#pendingEvents = new Map<string, PendingEvent>();
	#heartbeatInterval: NodeJS.Timeout | undefined;
	#reconnectAttempts = 0;
	readonly #maxReconnectAttempts = 3;
	#disposed = false;
	#buffer = "";
	#eventIdCounter = 0;
	#connectInFlight: Promise<boolean> | null = null;

	constructor(options: SessionBridgeOptions) {
		this.#options = options;
	}

	async connect(): Promise<boolean> {
		if (this.#disposed) return false;
		if (this.#connected) return true;
		if (this.#connectInFlight) return this.#connectInFlight;

		const socketPath = this.#resolveSocketPath();
		const { promise, resolve } = Promise.withResolvers<boolean>();
		this.#connectInFlight = promise;

		const socket = net.connect({ path: socketPath });
		let settled = false;

		const settle = (value: boolean): void => {
			if (settled) return;
			settled = true;
			this.#connectInFlight = null;
			resolve(value);
		};

		const handleConnect = (): void => {
			socket.off("error", handleConnectError);
			if (this.#disposed) {
				socket.destroy();
				settle(false);
				return;
			}

			this.#socket = socket;
			this.#connected = true;
			this.#reconnectAttempts = 0;
			this.#buffer = "";
			this.#attachSocketListeners(socket);
			this.#sendRegister();
			this.#startHeartbeat();
			settle(true);
		};

		const handleConnectError = (error: Error): void => {
			socket.off("connect", handleConnect);
			if (this.#socket === socket) {
				this.#socket = null;
			}
			this.#connected = false;

			if (isErrorWithCode(error) && (error.code === "ENOENT" || error.code === "ECONNREFUSED")) {
				logger.debug("Session bridge unavailable", { socketPath, code: error.code });
				settle(false);
				return;
			}

			logger.warn("Session bridge connect failed", {
				socketPath,
				error: error.message,
			});
			settle(false);
		};

		socket.once("connect", handleConnect);
		socket.once("error", handleConnectError);

		return promise;
	}

	emitBlockingEvent(payload: Omit<BlockingEventPayload, "eventId">): Promise<EventResponsePayload | null>;
	emitBlockingEvent(payload: BlockingEventPayload): Promise<EventResponsePayload | null>;
	emitBlockingEvent(
		payload: BlockingEventPayload | Omit<BlockingEventPayload, "eventId">,
	): Promise<EventResponsePayload | null> {
		if (!this.#connected || !this.#socket) {
			return Promise.resolve(null);
		}

		const eventId = "eventId" in payload ? payload.eventId : this.#generateEventId();
		const eventPayload = { ...payload, eventId } as BlockingEventPayload;
		const { promise, resolve } = Promise.withResolvers<EventResponsePayload | null>();
		this.#pendingEvents.set(eventId, { resolve });

		this.#send({
			type: "blocking_event",
			timestamp: Date.now(),
			payload: eventPayload,
		});

		return promise;
	}

	/**
	 * Fire-and-forget summary event push. Gated by either constructor flag
	 * or `SPELL_BRIDGE_EVENT_LOG=1`; otherwise this is a no-op.
	 */
	emitEventLog(entry: EventLogEntry): void {
		if (!this.#isEventLogEnabled()) return;
		if (!this.#connected || !this.#socket) return;
		if (!EVENT_LOG_ENTRY_KINDS.has(entry.kind)) return;
		const clipped: EventLogEntry =
			entry.text !== undefined && entry.text.length > EVENT_LOG_TEXT_MAX
				? { ...entry, text: entry.text.slice(0, EVENT_LOG_TEXT_MAX) }
				: entry;
		this.#send({
			type: "event_log",
			timestamp: Date.now(),
			entry: clipped,
		});
	}

	#isEventLogEnabled(): boolean {
		if (this.#options.eventLog === true) return true;
		return process.env.SPELL_BRIDGE_EVENT_LOG === "1";
	}

	notifyEventResolved(eventId: string): void {
		if (!this.#connected || !this.#socket) return;
		this.#send({
			type: "event_resolved",
			timestamp: Date.now(),
			eventId,
		});
	}

	isConnected(): boolean {
		return this.#connected;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#stopHeartbeat();
		this.#resolveAllPendingEvents(null);

		const socket = this.#socket;
		this.#connected = false;
		this.#socket = null;

		if (socket && !socket.destroyed) {
			socket.write(
				`${JSON.stringify({ type: "deregister", timestamp: Date.now() } satisfies SocketClientMessage)}\n`,
			);
			socket.end();
			socket.destroy();
		}
	}

	#resolveSocketPath(): string {
		if (this.#options.socketPath) {
			return this.#options.socketPath;
		}

		return path.join(os.homedir(), DEFAULT_SOCKET_RELATIVE_PATH);
	}

	#attachSocketListeners(socket: net.Socket): void {
		socket.on("data", chunk => {
			this.#buffer += chunk.toString();
			const lines = this.#buffer.split("\n");
			this.#buffer = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed.length === 0) continue;
				this.#handleLine(trimmed);
			}
		});

		socket.on("close", hadError => {
			if (this.#socket === socket) {
				this.#socket = null;
			}
			const wasConnected = this.#connected;
			this.#connected = false;
			this.#stopHeartbeat();
			this.#resolveAllPendingEvents(null);
			if (this.#disposed) return;
			if (wasConnected) {
				logger.debug("Session bridge disconnected", { hadError, sessionId: this.#options.sessionId });
			}
			void this.#attemptReconnect();
		});

		socket.on("error", error => {
			if (this.#disposed) return;
			logger.debug("Session bridge socket error", {
				sessionId: this.#options.sessionId,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	#send(msg: SocketClientMessage): void {
		if (!this.#socket || this.#socket.destroyed) return;
		this.#socket.write(`${JSON.stringify(msg)}\n`);
	}

	#handleLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			logger.warn("Session bridge message parse failed", {
				sessionId: this.#options.sessionId,
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}

		if (!isSocketServerMessage(parsed)) {
			logger.warn("Session bridge message ignored", { sessionId: this.#options.sessionId, line });
			return;
		}

		this.#handleMessage(parsed);
	}

	#handleMessage(msg: SocketServerMessage): void {
		switch (msg.type) {
			case "registered":
				this.#connected = true;
				logger.debug("Session bridge registered", {
					sessionId: this.#options.sessionId,
					serverVersion: msg.serverVersion,
				});
				return;
			case "event_response": {
				const pending = this.#pendingEvents.get(msg.eventId);
				if (!pending) return;
				this.#pendingEvents.delete(msg.eventId);
				pending.resolve(msg.payload);
				return;
			}
			case "event_cancelled": {
				const pending = this.#pendingEvents.get(msg.eventId);
				if (!pending) return;
				this.#pendingEvents.delete(msg.eventId);
				pending.resolve(null);
				return;
			}
		}
	}

	async #attemptReconnect(): Promise<void> {
		if (this.#disposed || this.#connected || this.#connectInFlight) return;
		if (this.#reconnectAttempts >= this.#maxReconnectAttempts) return;

		const delayMs = RECONNECT_DELAYS_MS[this.#reconnectAttempts] ?? RECONNECT_DELAYS_MS.at(-1) ?? 4_000;
		this.#reconnectAttempts += 1;
		await Bun.sleep(delayMs);
		if (this.#disposed || this.#connected) return;

		const connected = await this.connect();
		if (!connected && this.#reconnectAttempts < this.#maxReconnectAttempts) {
			await this.#attemptReconnect();
		}
	}

	#startHeartbeat(): void {
		this.#stopHeartbeat();
		this.#heartbeatInterval = setInterval(() => {
			if (!this.#connected || !this.#socket) return;
			this.#send({
				type: "heartbeat",
				timestamp: Date.now(),
				status: "active",
			});
		}, HEARTBEAT_INTERVAL_MS);
	}

	#stopHeartbeat(): void {
		if (!this.#heartbeatInterval) return;
		clearInterval(this.#heartbeatInterval);
		this.#heartbeatInterval = undefined;
	}

	#resolveAllPendingEvents(payload: EventResponsePayload | null): void {
		for (const [eventId, pending] of this.#pendingEvents) {
			this.#pendingEvents.delete(eventId);
			pending.resolve(payload);
		}
	}

	#sendRegister(): void {
		this.#send({
			type: "register",
			timestamp: Date.now(),
			sessionId: this.#options.sessionId,
			pid: this.#options.pid,
			cwd: this.#options.cwd,
			mode: this.#options.mode,
			startedAt: this.#options.startedAt,
			projectName: this.#options.projectName,
		});
	}

	#generateEventId(): string {
		this.#eventIdCounter += 1;
		return `${this.#options.sessionId}-${this.#eventIdCounter}`;
	}
}

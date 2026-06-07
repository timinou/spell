import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@spell/pi-utils";
import {
	type BlockingEventPayload,
	EVENT_LOG_ENTRY_KINDS,
	type EventLogEntry,
	type EventResponsePayload,
	type InjectDeliverAs,
	type SocketClientMessage,
	type SocketServerMessage,
} from "./types";

/**
 * Clip length for low-fidelity summary kinds (tool intents, errors, ...). These
 * are one-line glances, not content, so a tight clamp keeps frames small.
 */
const EVENT_LOG_TEXT_MAX = 256;

/**
 * Per-frame text budget for *content* kinds (assistant/user messages). Long
 * messages are split into ordered chunks under this cap rather than truncated,
 * so the web transcript shows the full message while no single WS frame (or
 * ring-buffer entry) grows unbounded. Continuation chunks carry `meta.cont`;
 * non-final chunks carry `meta.more` so the renderer reassembles one line.
 */
const EVENT_LOG_CHUNK_MAX = 8_192;

/** Kinds whose `text` is real content and must be delivered in full (chunked). */
const EVENT_LOG_CONTENT_KINDS: ReadonlySet<EventLogEntry["kind"]> = new Set(["assistant_text", "user_message"]);

const DEFAULT_SOCKET_RELATIVE_PATH = ".spell/server.sock";
const HEARTBEAT_INTERVAL_MS = 30_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000] as const;
/**
 * Backoff schedule for the persistent supervisor. Unlike the legacy
 * capped retry, the supervisor never gives up while the session lives — a
 * server can be started (or restarted) at any time and every TUI must
 * (re)register. The last value repeats indefinitely.
 */
const SUPERVISE_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000] as const;

type PendingEvent = {
	resolve: (payload: EventResponsePayload | null) => void;
};

/**
 * Handles a server-pushed input injection. Returns whether the message was
 * accepted as a real user turn (and an optional reason when not).
 */
export type InjectInputHandler = (input: {
	injectId: string;
	text: string;
	deliverAs: InjectDeliverAs;
}) => Promise<{ accepted: boolean; reason?: string }>;

export interface SessionBridgeOptions {
	socketPath?: string;
	sessionId: string;
	pid: number;
	cwd: string;
	mode: string;
	startedAt: number;
	projectName: string;
	/** Absolute artifacts directory for this session (for server-side listing/watch). */
	sessionRoot?: string;
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
	#supervising = false;
	#superviseTimer: NodeJS.Timeout | undefined;
	#superviseAttempts = 0;
	#buffer = "";
	#eventIdCounter = 0;
	#connectInFlight: Promise<boolean> | null = null;
	#injectHandler: InjectInputHandler | undefined;
	#eventLogEnabled = false;

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

		// Content kinds (assistant/user text) are delivered in full, split into
		// ordered chunks so a long message survives intact without any single frame
		// growing unbounded. Low-fi summary kinds keep the tight one-line clamp.
		if (
			entry.text !== undefined &&
			EVENT_LOG_CONTENT_KINDS.has(entry.kind) &&
			entry.text.length > EVENT_LOG_CHUNK_MAX
		) {
			this.#emitChunked(entry);
			return;
		}

		const clipped: EventLogEntry =
			entry.text !== undefined && !EVENT_LOG_CONTENT_KINDS.has(entry.kind) && entry.text.length > EVENT_LOG_TEXT_MAX
				? { ...entry, text: entry.text.slice(0, EVENT_LOG_TEXT_MAX) }
				: entry;
		this.#send({
			type: "event_log",
			timestamp: Date.now(),
			entry: clipped,
		});
	}

	/**
	 * Split a long content message into ordered `event_log` frames. The first
	 * frame renders with its normal prefix; continuation frames set `meta.cont`
	 * (renderer omits the timestamp prefix) and every non-final frame sets
	 * `meta.more` (renderer omits the trailing newline) so the web side stitches
	 * the chunks back into a single logical line.
	 */
	#emitChunked(entry: EventLogEntry): void {
		const text = entry.text ?? "";
		for (let offset = 0; offset < text.length; offset += EVENT_LOG_CHUNK_MAX) {
			const slice = text.slice(offset, offset + EVENT_LOG_CHUNK_MAX);
			const isFirst = offset === 0;
			const isLast = offset + EVENT_LOG_CHUNK_MAX >= text.length;
			const meta: Record<string, string | number | boolean> = { ...entry.meta };
			if (!isFirst) meta.cont = true;
			if (!isLast) meta.more = true;
			this.#send({
				type: "event_log",
				timestamp: Date.now(),
				entry: { ...entry, text: slice, meta: Object.keys(meta).length > 0 ? meta : undefined },
			});
		}
	}

	/**
	 * Turn on summary event forwarding at runtime (used when an interactive
	 * session connects to the user's own control server and wants its terminal
	 * activity mirrored to the web transcript).
	 */
	enableEventLog(): void {
		this.#eventLogEnabled = true;
	}

	#isEventLogEnabled(): boolean {
		if (this.#eventLogEnabled) return true;
		if (this.#options.eventLog === true) return true;
		return process.env.SPELL_BRIDGE_EVENT_LOG === "1";
	}

	/**
	 * Register the callback invoked when the server pushes an `inject_input`
	 * frame (a remote operator steering this terminal session). The client
	 * always replies with `inject_ack` reflecting the handler's verdict.
	 */
	onInjectInput(handler: InjectInputHandler): void {
		this.#injectHandler = handler;
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

	/**
	 * Begin supervising the connection: connect now, and keep (re)connecting
	 * forever with backoff until disposed. This is what makes "one server
	 * controls all sessions" hold regardless of start order or server restarts —
	 * a TUI started before the server, or surviving a server restart, will
	 * register as soon as the socket becomes available again.
	 *
	 * Returns the result of the FIRST connection attempt so callers can log
	 * initial reachability; the background loop continues regardless.
	 */
	async start(): Promise<boolean> {
		if (this.#disposed) return false;
		this.#supervising = true;
		const connected = await this.connect();
		if (!connected && !this.#disposed) {
			this.#scheduleSupervise();
		}
		return connected;
	}

	#scheduleSupervise(): void {
		if (this.#disposed || !this.#supervising || this.#connected || this.#superviseTimer) {
			return;
		}
		const idx = Math.min(this.#superviseAttempts, SUPERVISE_DELAYS_MS.length - 1);
		const delayMs = SUPERVISE_DELAYS_MS[idx];
		this.#superviseAttempts += 1;
		this.#superviseTimer = setTimeout(() => {
			this.#superviseTimer = undefined;
			if (this.#disposed || this.#connected) return;
			void this.connect().then(connected => {
				if (connected) {
					this.#superviseAttempts = 0;
				} else {
					this.#scheduleSupervise();
				}
			});
		}, delayMs);
		if (this.#superviseTimer && typeof this.#superviseTimer.unref === "function") {
			this.#superviseTimer.unref();
		}
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#supervising = false;
		if (this.#superviseTimer) {
			clearTimeout(this.#superviseTimer);
			this.#superviseTimer = undefined;
		}
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
			// When supervising (the steady-state mode), keep trying forever so a
			// server restart re-registers this session. Otherwise fall back to the
			// legacy capped retry.
			if (this.#supervising) {
				this.#superviseAttempts = 0;
				this.#scheduleSupervise();
			} else {
				void this.#attemptReconnect();
			}
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
			case "inject_input": {
				void this.#handleInjectInput(msg.injectId, msg.text, msg.deliverAs);
				return;
			}
		}
	}

	async #handleInjectInput(injectId: string, text: string, deliverAs: InjectDeliverAs): Promise<void> {
		let result: { accepted: boolean; reason?: string };
		if (!this.#injectHandler) {
			result = { accepted: false, reason: "no_handler" };
		} else {
			try {
				result = await this.#injectHandler({ injectId, text, deliverAs });
			} catch (error) {
				result = { accepted: false, reason: error instanceof Error ? error.message : String(error) };
			}
		}
		this.#send({
			type: "inject_ack",
			timestamp: Date.now(),
			injectId,
			accepted: result.accepted,
			reason: result.reason,
		});
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
			sessionRoot: this.#options.sessionRoot,
		});
	}

	#generateEventId(): string {
		this.#eventIdCounter += 1;
		return `${this.#options.sessionId}-${this.#eventIdCounter}`;
	}
}

import type * as net from "node:net";
import type { RpcClient } from "../rpc/rpc-client";
import type {
	BlockingEventPayload,
	BridgeRpcRequest,
	BridgeRpcResult,
	EventLogEntry,
	EventResponsePayload,
	InjectDeliverAs,
	SocketServerMessage,
} from "./types";

/** Result of a remote message injection attempt. */
export interface InjectResult {
	accepted: boolean;
	reason?: string;
}

interface PendingInject {
	sessionId: string;
	resolve: (result: InjectResult) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface PendingRpc {
	sessionId: string;
	resolve: (result: BridgeRpcResult) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** How long to wait for a client `inject_ack` before giving up. */
const INJECT_ACK_TIMEOUT_MS = 10_000;

/** How long to wait for a proxied `rpc_response` before giving up (FEAT-815). */
const RPC_RESPONSE_TIMEOUT_MS = 30_000;

export type SessionKind = "external" | "spawned";

export interface SessionRegistryEntry {
	sessionId: string;
	kind: SessionKind;
	pid: number;
	cwd: string;
	mode: string;
	startedAt: number;
	projectName: string;
	lastHeartbeat: number;
	currentBlockingEvent?: BlockingEventPayload;
	/**
	 * Absolute artifacts directory for the session. For external sessions it is
	 * reported by the bridge at register time; lets the server list + watch
	 * artifacts for terminal sessions the same way it does for spawned ones.
	 */
	sessionRoot?: string;
	/** Present only for kind = 'external' (the bridge socket connection). */
	connection?: net.Socket;
	/**
	 * For kind = 'spawned': identity name (web token holder) that owns the
	 * session. Used for the `ownedBy` chip on the frontend.
	 */
	ownedBy?: string;
	/** For kind = 'spawned': source template name (when applicable). */
	templateName?: string;
	/**
	 * For kind = 'spawned': hint extensions the frontend should default-filter
	 * artifact-watch subscriptions to.
	 */
	watchExtensions?: string[];
	/** For kind = 'spawned': the alive RpcClient driving the session. */
	rpcClient?: RpcClient;
}

type SessionMetadata = Pick<
	SessionRegistryEntry,
	"pid" | "cwd" | "mode" | "startedAt" | "projectName" | "sessionRoot"
>;

export interface SpawnedRegistration {
	sessionId: string;
	ownedBy: string;
	templateName?: string;
	watchExtensions?: string[];
	rpcClient: RpcClient;
	metadata: SessionMetadata;
}

type BlockingEventHandler = (sessionId: string, event: BlockingEventPayload) => void;
type BlockingEventClearedHandler = (sessionId: string) => void;
type SessionChangeHandler = (type: "registered" | "deregistered", sessionId: string) => void;
type EventLogHandler = (sessionId: string, entry: EventLogEntry) => void;

/**
 * Default cap for the per-session ring buffer. Tuned so a fast-moving session
 * keeps a meaningful tail without ballooning resident memory across hundreds
 * of concurrent CLI sessions.
 */
const DEFAULT_RECENT_LOG_CAP = 50;

export interface SocketSessionRegistryOptions {
	recentLogCap?: number;
}

export class SocketSessionRegistry {
	#sessions = new Map<string, SessionRegistryEntry>();
	#blockingEventHandlers = new Set<BlockingEventHandler>();
	#blockingEventClearedHandlers = new Set<BlockingEventClearedHandler>();
	#sessionChangeHandlers = new Set<SessionChangeHandler>();
	#eventLogHandlers = new Set<EventLogHandler>();
	#recentLog = new Map<string, EventLogEntry[]>();
	#recentLogCap: number;
	#pendingInjects = new Map<string, PendingInject>();
	#injectCounter = 0;
	#pendingRpcs = new Map<string, PendingRpc>();
	#rpcCounter = 0;

	constructor(options: SocketSessionRegistryOptions = {}) {
		this.#recentLogCap = options.recentLogCap ?? DEFAULT_RECENT_LOG_CAP;
	}

	register(sessionId: string, metadata: SessionMetadata, connection: net.Socket): void {
		const existing = this.#sessions.get(sessionId);
		if (existing?.connection && existing.connection !== connection) {
			existing.connection.destroy();
		}

		this.#sessions.set(sessionId, {
			sessionId,
			kind: "external",
			...metadata,
			lastHeartbeat: Date.now(),
			connection,
		});
		this.#emitSessionChange("registered", sessionId);
	}

	/**
	 * Register a server-spawned RPC session into the unified registry. No
	 * net.Socket is involved — the spawned session is steered via its
	 * `RpcClient` directly.
	 */
	registerSpawned(args: SpawnedRegistration): void {
		this.#sessions.set(args.sessionId, {
			sessionId: args.sessionId,
			kind: "spawned",
			...args.metadata,
			lastHeartbeat: Date.now(),
			ownedBy: args.ownedBy,
			templateName: args.templateName,
			watchExtensions: args.watchExtensions,
			rpcClient: args.rpcClient,
		});
		this.#emitSessionChange("registered", args.sessionId);
	}

	getSpawned(): SessionRegistryEntry[] {
		return this.getActive().filter(entry => entry.kind === "spawned");
	}

	getExternal(): SessionRegistryEntry[] {
		return this.getActive().filter(entry => entry.kind === "external");
	}

	getAll(): SessionRegistryEntry[] {
		return [
			...this.getSpawned().sort((a, b) => a.startedAt - b.startedAt),
			...this.getExternal().sort((a, b) => a.startedAt - b.startedAt),
		];
	}

	/**
	 * Deregister only if the entry is still bound to `connection`. Used by the
	 * socket server's per-connection cleanup so a *stale* socket closing (after
	 * its session already re-registered over a fresh socket) cannot evict the
	 * live entry.
	 *
	 * Race it closes: on a fast reconnect the OS may deliver the new socket's
	 * `register` before the old socket's `close`. `register()` destroys the old
	 * socket, whose deferred `close` would otherwise `deregister` the just-
	 * registered live session. Guarding on identity makes the cleanup a no-op in
	 * that case.
	 */
	deregisterIfConnection(sessionId: string, connection: net.Socket): void {
		const entry = this.#sessions.get(sessionId);
		if (!entry || entry.connection !== connection) {
			return;
		}
		this.deregister(sessionId);
	}

	deregister(sessionId: string): void {
		if (!this.#sessions.delete(sessionId)) {
			return;
		}
		this.#recentLog.delete(sessionId);
		for (const [injectId, pending] of this.#pendingInjects) {
			if (pending.sessionId === sessionId) {
				this.#pendingInjects.delete(injectId);
				clearTimeout(pending.timer);
				pending.resolve({ accepted: false, reason: "deregistered" });
			}
		}
		for (const [requestId, pending] of this.#pendingRpcs) {
			if (pending.sessionId === sessionId) {
				this.#pendingRpcs.delete(requestId);
				clearTimeout(pending.timer);
				pending.resolve({ type: "response", command: "unknown", success: false, error: "deregistered" });
			}
		}
		this.#emitSessionChange("deregistered", sessionId);
	}

	appendEventLog(sessionId: string, entry: EventLogEntry): void {
		if (!this.#sessions.has(sessionId)) return;
		let log = this.#recentLog.get(sessionId);
		if (!log) {
			log = [];
			this.#recentLog.set(sessionId, log);
		}
		log.push(entry);
		while (log.length > this.#recentLogCap) {
			log.shift();
		}
		for (const handler of this.#eventLogHandlers) {
			handler(sessionId, entry);
		}
	}

	getRecentLog(sessionId: string): EventLogEntry[] {
		const log = this.#recentLog.get(sessionId);
		return log ? [...log] : [];
	}

	onEventLog(handler: EventLogHandler): void {
		this.#eventLogHandlers.add(handler);
	}

	offEventLog(handler: EventLogHandler): void {
		this.#eventLogHandlers.delete(handler);
	}

	getActive(): SessionRegistryEntry[] {
		return [...this.#sessions.values()];
	}

	getBlocked(): SessionRegistryEntry[] {
		return this.getActive().filter(entry => entry.currentBlockingEvent !== undefined);
	}

	getSession(sessionId: string): SessionRegistryEntry | undefined {
		return this.#sessions.get(sessionId);
	}

	setBlockingEvent(sessionId: string, event: BlockingEventPayload): void {
		const entry = this.#sessions.get(sessionId);
		if (!entry) {
			return;
		}

		entry.currentBlockingEvent = event;
		for (const handler of this.#blockingEventHandlers) {
			handler(sessionId, event);
		}
	}

	clearBlockingEvent(sessionId: string): void {
		const entry = this.#sessions.get(sessionId);
		if (!entry) {
			return;
		}
		if (entry.currentBlockingEvent === undefined) {
			return;
		}

		entry.currentBlockingEvent = undefined;
		for (const handler of this.#blockingEventClearedHandlers) {
			handler(sessionId);
		}
	}

	resolveEvent(sessionId: string, eventId: string, payload: EventResponsePayload): void {
		const entry = this.#sessions.get(sessionId);
		if (!entry) return;
		if (entry.currentBlockingEvent?.eventId !== eventId) return;
		if (!entry.connection || entry.connection.destroyed) return;

		const message: SocketServerMessage = {
			type: "event_response",
			eventId,
			payload,
			timestamp: Date.now(),
		};
		entry.connection.write(`${JSON.stringify(message)}\n`);
		this.clearBlockingEvent(sessionId);
	}

	/**
	 * Push a free-form input message to a registered external session over its
	 * bridge socket, to be delivered as a real user turn. Resolves when the
	 * session acknowledges (or the wait times out / the connection is dead).
	 *
	 * Only external sessions have a `connection`; spawned sessions are steered
	 * via their RpcClient and must not reach this path.
	 */
	injectMessage(
		sessionId: string,
		input: { text: string; deliverAs: InjectDeliverAs },
		timeoutMs = INJECT_ACK_TIMEOUT_MS,
	): Promise<InjectResult> {
		const entry = this.#sessions.get(sessionId);
		if (!entry) {
			return Promise.resolve({ accepted: false, reason: "unknown_session" });
		}
		if (entry.kind !== "external" || !entry.connection || entry.connection.destroyed) {
			return Promise.resolve({ accepted: false, reason: "not_connected" });
		}

		this.#injectCounter += 1;
		const injectId = `${sessionId}-inject-${this.#injectCounter}`;
		const message: SocketServerMessage = {
			type: "inject_input",
			injectId,
			text: input.text,
			deliverAs: input.deliverAs,
			timestamp: Date.now(),
		};

		const { promise, resolve } = Promise.withResolvers<InjectResult>();
		const timer = setTimeout(() => {
			if (this.#pendingInjects.delete(injectId)) {
				resolve({ accepted: false, reason: "ack_timeout" });
			}
		}, timeoutMs);
		if (timer && "unref" in timer) {
			(timer as NodeJS.Timeout).unref();
		}
		this.#pendingInjects.set(injectId, { sessionId, resolve, timer });

		try {
			entry.connection.write(`${JSON.stringify(message)}\n`);
		} catch (error) {
			clearTimeout(timer);
			this.#pendingInjects.delete(injectId);
			return Promise.resolve({ accepted: false, reason: `write_failed: ${String(error)}` });
		}
		return promise;
	}

	/** Resolve a pending inject when the client's `inject_ack` arrives. */
	resolveInject(injectId: string, accepted: boolean, reason?: string): void {
		const pending = this.#pendingInjects.get(injectId);
		if (!pending) return;
		this.#pendingInjects.delete(injectId);
		clearTimeout(pending.timer);
		pending.resolve({ accepted, reason });
	}

	/**
	 * Proxy a BridgeRpcCommand to an external session over its bridge socket and
	 * resolve with the typed result the CLI returns (FEAT-815 duplex). This is
	 * the external-session analogue of the spawned hub's `RpcClient.send`. Only
	 * external sessions have a `connection`; spawned sessions use their RpcClient.
	 */
	requestRpc(
		sessionId: string,
		command: BridgeRpcRequest,
		timeoutMs = RPC_RESPONSE_TIMEOUT_MS,
	): Promise<BridgeRpcResult> {
		const entry = this.#sessions.get(sessionId);
		if (!entry) {
			return Promise.resolve({ type: "response", command: command.type, success: false, error: "unknown_session" });
		}
		if (entry.kind !== "external" || !entry.connection || entry.connection.destroyed) {
			return Promise.resolve({ type: "response", command: command.type, success: false, error: "not_connected" });
		}

		this.#rpcCounter += 1;
		const requestId = `${sessionId}-rpc-${this.#rpcCounter}`;
		const message: SocketServerMessage = {
			type: "rpc_request",
			requestId,
			command,
			timestamp: Date.now(),
		};

		const { promise, resolve } = Promise.withResolvers<BridgeRpcResult>();
		const timer = setTimeout(() => {
			if (this.#pendingRpcs.delete(requestId)) {
				resolve({ type: "response", command: command.type, success: false, error: "rpc_timeout" });
			}
		}, timeoutMs);
		if (timer && "unref" in timer) {
			(timer as NodeJS.Timeout).unref();
		}
		this.#pendingRpcs.set(requestId, { sessionId, resolve, timer });

		try {
			entry.connection.write(`${JSON.stringify(message)}\n`);
		} catch (error) {
			clearTimeout(timer);
			this.#pendingRpcs.delete(requestId);
			return Promise.resolve({ type: "response", command: command.type, success: false, error: `write_failed: ${String(error)}` });
		}
		return promise;
	}

	/** Resolve a pending proxied RPC when the client's `rpc_response` arrives. */
	resolveRpc(requestId: string, response: BridgeRpcResult): void {
		const pending = this.#pendingRpcs.get(requestId);
		if (!pending) return;
		this.#pendingRpcs.delete(requestId);
		clearTimeout(pending.timer);
		pending.resolve(response);
	}

	cancelEvent(sessionId: string, eventId: string, reason?: string): void {
		const entry = this.#sessions.get(sessionId);
		if (!entry) return;
		if (entry.currentBlockingEvent?.eventId !== eventId) return;
		if (!entry.connection || entry.connection.destroyed) return;

		const message: SocketServerMessage = {
			type: "event_cancelled",
			eventId,
			reason,
			timestamp: Date.now(),
		};
		entry.connection.write(`${JSON.stringify(message)}\n`);
		this.clearBlockingEvent(sessionId);
	}

	onBlockingEvent(handler: BlockingEventHandler): void {
		this.#blockingEventHandlers.add(handler);
	}

	offBlockingEvent(handler: BlockingEventHandler): void {
		this.#blockingEventHandlers.delete(handler);
	}

	onBlockingEventCleared(handler: BlockingEventClearedHandler): void {
		this.#blockingEventClearedHandlers.add(handler);
	}

	offBlockingEventCleared(handler: BlockingEventClearedHandler): void {
		this.#blockingEventClearedHandlers.delete(handler);
	}

	onSessionChange(handler: SessionChangeHandler): void {
		this.#sessionChangeHandlers.add(handler);
	}

	offSessionChange(handler: SessionChangeHandler): void {
		this.#sessionChangeHandlers.delete(handler);
	}

	updateHeartbeat(sessionId: string): void {
		const entry = this.#sessions.get(sessionId);
		if (!entry) {
			return;
		}

		entry.lastHeartbeat = Date.now();
	}

	cleanupStale(): void {
		for (const [sessionId, entry] of this.#sessions) {
			if (entry.kind === "spawned") {
				if (entry.rpcClient && !entry.rpcClient.alive) {
					this.deregister(sessionId);
				}
				continue;
			}
			try {
				process.kill(entry.pid, 0);
			} catch {
				this.deregister(sessionId);
			}
		}
	}

	#emitSessionChange(type: "registered" | "deregistered", sessionId: string): void {
		for (const handler of this.#sessionChangeHandlers) {
			handler(type, sessionId);
		}
	}
}

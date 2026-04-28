import type * as net from "node:net";
import type { RpcClient } from "../rpc/rpc-client";
import type { BlockingEventPayload, EventLogEntry, EventResponsePayload, SocketServerMessage } from "./types";

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

type SessionMetadata = Pick<SessionRegistryEntry, "pid" | "cwd" | "mode" | "startedAt" | "projectName">;

export interface SpawnedRegistration {
	sessionId: string;
	ownedBy: string;
	templateName?: string;
	watchExtensions?: string[];
	rpcClient: RpcClient;
	metadata: SessionMetadata;
}

type BlockingEventHandler = (sessionId: string, event: BlockingEventPayload) => void;
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
	#sessionChangeHandlers = new Set<SessionChangeHandler>();
	#eventLogHandlers = new Set<EventLogHandler>();
	#recentLog = new Map<string, EventLogEntry[]>();
	#recentLogCap: number;

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

	deregister(sessionId: string): void {
		if (!this.#sessions.delete(sessionId)) {
			return;
		}
		this.#recentLog.delete(sessionId);
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

		entry.currentBlockingEvent = undefined;
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

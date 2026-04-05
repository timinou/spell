import type * as net from "node:net";
import type { BlockingEventPayload, EventResponsePayload, SocketServerMessage } from "./types";

export interface SessionRegistryEntry {
	sessionId: string;
	pid: number;
	cwd: string;
	mode: string;
	startedAt: number;
	projectName: string;
	lastHeartbeat: number;
	currentBlockingEvent?: BlockingEventPayload;
	connection: net.Socket;
}

type SessionMetadata = Omit<
	SessionRegistryEntry,
	"sessionId" | "lastHeartbeat" | "currentBlockingEvent" | "connection"
>;

type BlockingEventHandler = (sessionId: string, event: BlockingEventPayload) => void;
type SessionChangeHandler = (type: "registered" | "deregistered", sessionId: string) => void;

export class SocketSessionRegistry {
	#sessions = new Map<string, SessionRegistryEntry>();
	#blockingEventHandlers = new Set<BlockingEventHandler>();
	#sessionChangeHandlers = new Set<SessionChangeHandler>();

	register(sessionId: string, metadata: SessionMetadata, connection: net.Socket): void {
		const existing = this.#sessions.get(sessionId);
		if (existing && existing.connection !== connection) {
			existing.connection.destroy();
		}

		this.#sessions.set(sessionId, {
			sessionId,
			...metadata,
			lastHeartbeat: Date.now(),
			connection,
		});
		this.#emitSessionChange("registered", sessionId);
	}

	deregister(sessionId: string): void {
		if (!this.#sessions.delete(sessionId)) {
			return;
		}
		this.#emitSessionChange("deregistered", sessionId);
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
		if (entry.connection.destroyed) return;

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
		if (entry.connection.destroyed) return;

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

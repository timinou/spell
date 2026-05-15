import { logger } from "@oh-my-pi/pi-utils";
import type { ServerWebSocket } from "bun";
import type { WebIdentity } from "../../http/types";
import type { ArtifactCreatedEvent } from "../artifacts/types";
import { filterByExt } from "../artifacts/watcher";
import type { Channel, WsServerMessage } from "./protocol";

interface SubscriptionState {
	channels: Set<Channel>;
	artifactExt?: string[];
}

export interface WebConnectionData {
	identity: WebIdentity;
}

/**
 * Per-WS connection state. Tracks identity + per-session subscriptions; the
 * fan-out router consults these maps to decide whether to forward an event
 * to this socket.
 */
export class WebConnection {
	#ws: ServerWebSocket<WebConnectionData>;
	#subs = new Map<string, SubscriptionState>();
	/** Hub-side unsubscribe handles, keyed by `<sessionId>:<channel>`. Replaced
	 * on resubscribe and drained on dispose so per-connection listeners never
	 * outlive their WebSocket. */
	#taps = new Map<string, () => void>();
	identity: WebIdentity;

	constructor(ws: ServerWebSocket<WebConnectionData>, identity: WebIdentity) {
		this.#ws = ws;
		this.identity = identity;
	}

	send(msg: WsServerMessage): void {
		try {
			this.#ws.send(JSON.stringify(msg));
		} catch (error) {
			logger.debug("ws send failed", { error: String(error) });
		}
	}

	subscribe(sessionId: string, channels: Channel[], artifactExt?: string[]): void {
		const existing = this.#subs.get(sessionId);
		if (existing) {
			for (const channel of channels) existing.channels.add(channel);
			if (artifactExt) existing.artifactExt = artifactExt;
			return;
		}
		this.#subs.set(sessionId, { channels: new Set(channels), artifactExt });
	}

	unsubscribe(sessionId: string, channels?: Channel[]): void {
		const existing = this.#subs.get(sessionId);
		if (!existing) return;
		if (!channels) {
			this.#subs.delete(sessionId);
			return;
		}
		for (const channel of channels) existing.channels.delete(channel);
		if (existing.channels.size === 0) this.#subs.delete(sessionId);
	}

	/** Quick test for whether this connection wants events on `(sessionId, channel)`. */
	wants(sessionId: string, channel: Channel): boolean {
		const sub = this.#subs.get(sessionId);
		return Boolean(sub?.channels.has(channel));
	}

	/** Apply the connection's per-session ext filter to an artifact event. */
	wantsArtifact(sessionId: string, event: ArtifactCreatedEvent): boolean {
		const sub = this.#subs.get(sessionId);
		if (!sub?.channels.has("artifacts")) return false;
		return filterByExt(sub.artifactExt, event);
	}

	/** Register a hub-side unsubscribe handle; replaces any prior tap for the
	 * same `(sessionId, channel)` so resubscribes don't leak listeners. */
	registerTap(sessionId: string, channel: Channel, unsub: () => void): void {
		const key = `${sessionId}:${channel}`;
		const existing = this.#taps.get(key);
		if (existing) {
			try {
				existing();
			} catch (error) {
				logger.debug("prior tap unsubscribe threw", { error: String(error) });
			}
		}
		this.#taps.set(key, unsub);
	}

	/** Drop all subscriptions and drain registered taps on disconnect. */
	dispose(): void {
		this.#subs.clear();
		for (const unsub of this.#taps.values()) {
			try {
				unsub();
			} catch (error) {
				logger.debug("tap unsubscribe threw on dispose", { error: String(error) });
			}
		}
		this.#taps.clear();
	}
}

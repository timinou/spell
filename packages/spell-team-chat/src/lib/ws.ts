import type { WsClientMessage, WsServerMessage } from "./protocol";

/** Distributes Omit across union variants so discriminated fields survive. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 16000, 30000];

export type WsStatus = "connecting" | "open" | "auth_ok" | "closed";

export interface WsClientOpts {
	url: string;
	onMessage: (msg: WsServerMessage) => void;
	onStatus?: (status: WsStatus) => void;
}

/**
 * Reconnecting WebSocket bound to /web/ws.
 * - Queues sends until `auth_ok` flushes them.
 * - Exposes `request()` for correlation-id round-trips (used by RPC, spawn,
 *   mint_artifact_url) with a 30s timeout.
 */
export class WsClient {
	#opts: WsClientOpts;
	#ws: WebSocket | null = null;
	#queue: string[] = [];
	#authed = false;
	#disposed = false;
	#attempt = 0;
	#cid = 0;
	#pending = new Map<
		string,
		{ resolve: (msg: WsServerMessage) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
	>();

	constructor(opts: WsClientOpts) {
		this.#opts = opts;
		this.#connect();
	}

	get isAuthed(): boolean {
		return this.#authed;
	}

	send(msg: WsClientMessage): void {
		const line = JSON.stringify(msg);
		if (this.#authed && this.#ws?.readyState === WebSocket.OPEN) {
			this.#ws.send(line);
			return;
		}
		this.#queue.push(line);
	}

	/** Send a message with a generated correlationId and wait for a matching reply. */
	async request<T extends WsServerMessage = WsServerMessage>(
		msg: DistributiveOmit<WsClientMessage, "correlationId">,
		timeoutMs = 30_000,
	): Promise<T> {
		this.#cid += 1;
		const correlationId = `c${this.#cid}`;
		const composed = { ...msg, correlationId } as WsClientMessage;
		const { promise, resolve, reject } = Promise.withResolvers<WsServerMessage>();
		const timer = setTimeout(() => {
			this.#pending.delete(correlationId);
			reject(new Error(`WS request timed out: ${msg.type}`));
		}, timeoutMs);
		this.#pending.set(correlationId, { resolve, reject, timer });
		this.send(composed);
		return (await promise) as T;
	}

	dispose(): void {
		this.#disposed = true;
		this.#authed = false;
		this.#queue = [];
		for (const { timer } of this.#pending.values()) clearTimeout(timer);
		this.#pending.clear();
		this.#ws?.close();
		this.#ws = null;
	}

	#connect(): void {
		if (this.#disposed) return;
		this.#opts.onStatus?.("connecting");
		const ws = new WebSocket(this.#opts.url);
		this.#ws = ws;
		ws.addEventListener("open", () => {
			this.#opts.onStatus?.("open");
			this.#attempt = 0;
		});
		ws.addEventListener("message", e => {
			let parsed: WsServerMessage;
			try {
				parsed = JSON.parse(typeof e.data === "string" ? e.data : "") as WsServerMessage;
			} catch {
				return;
			}
			if (parsed.type === "auth_ok") {
				this.#authed = true;
				this.#opts.onStatus?.("auth_ok");
				const queued = this.#queue;
				this.#queue = [];
				for (const line of queued) ws.send(line);
			}
			const cid = (parsed as { correlationId?: string }).correlationId;
			if (cid && this.#pending.has(cid)) {
				const pend = this.#pending.get(cid);
				if (pend) {
					clearTimeout(pend.timer);
					this.#pending.delete(cid);
					if (parsed.type === "error") {
						pend.reject(new Error(`${parsed.code}: ${parsed.message}`));
					} else {
						pend.resolve(parsed);
					}
				}
			}
			this.#opts.onMessage(parsed);
		});
		ws.addEventListener("close", () => {
			this.#authed = false;
			this.#opts.onStatus?.("closed");
			this.#ws = null;
			if (this.#disposed) return;
			const delay = RECONNECT_DELAYS_MS[Math.min(this.#attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 30000;
			this.#attempt += 1;
			setTimeout(() => this.#connect(), delay);
		});
		ws.addEventListener("error", () => ws.close());
	}
}

export function buildWsUrl(token: string): string {
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	const host = location.host;
	return `${proto}//${host}/web/ws?token=${encodeURIComponent(token)}`;
}

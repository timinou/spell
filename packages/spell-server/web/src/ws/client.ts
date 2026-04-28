type AnyMessage = Record<string, unknown> & { type: string };

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000];

export interface SpellWsClientOptions {
	url: string;
	onMessage: (msg: AnyMessage) => void;
	onStatus?: (status: "connecting" | "open" | "closed" | "auth_ok") => void;
}

/**
 * Minimal typed WebSocket client. Auto-reconnects with capped backoff. Sends
 * are queued until the server delivers `auth_ok`.
 */
export class SpellWsClient {
	#opts: SpellWsClientOptions;
	#ws: WebSocket | null = null;
	#queue: string[] = [];
	#authed = false;
	#disposed = false;
	#attempt = 0;

	constructor(opts: SpellWsClientOptions) {
		this.#opts = opts;
		this.#connect();
	}

	send(msg: AnyMessage): void {
		const line = JSON.stringify(msg);
		if (this.#authed && this.#ws?.readyState === WebSocket.OPEN) {
			this.#ws.send(line);
			return;
		}
		this.#queue.push(line);
	}

	dispose(): void {
		this.#disposed = true;
		this.#authed = false;
		this.#queue = [];
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
			let parsed: AnyMessage;
			try {
				parsed = JSON.parse(typeof e.data === "string" ? e.data : "");
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
	const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
	return `${proto}//${window.location.host}/web/ws?token=${encodeURIComponent(token)}`;
}

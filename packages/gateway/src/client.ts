/**
 * Gateway client SDK — typed RPC client over Unix socket NDJSON protocol.
 *
 * Features:
 * - Auto-spawn daemon if socket not available
 * - Request/response ID correlation for concurrent requests
 * - Reconnect on connection failure
 * - All control plane RPCs as typed methods
 */
import * as net from "node:net";
import { logger } from "@oh-my-pi/pi-utils";
import {
	type GatewayRequest,
	type GatewayResponse,
	parseMessage,
	resolveSocketPath,
	type ServiceConfig,
	type ServiceEntry,
	serializeMessage,
} from "./protocol";

/** Distribute Omit over a discriminated union so per-variant fields survive. */
type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

const REQUEST_TIMEOUT_MS = 10_000;
const RECONNECT_DELAYS_MS = [100, 200, 400, 500];

export interface GatewayClientOptions {
	socketPath?: string;
	autoSpawn?: boolean;
}

export class GatewayClient {
	#socketPath: string;
	#autoSpawn: boolean;
	#socket: net.Socket | null = null;
	#connected = false;
	#disposed = false;
	#pending = new Map<string, { resolve: (v: GatewayResponse) => void; reject: (e: Error) => void; timer: Timer }>();
	#buffer = "";
	#idCounter = 0;

	constructor(options?: GatewayClientOptions) {
		this.#socketPath = options?.socketPath ?? resolveSocketPath();
		this.#autoSpawn = options?.autoSpawn ?? true;
	}

	get connected(): boolean {
		return this.#connected;
	}

	// -----------------------------------------------------------------------
	// Public RPC methods
	// -----------------------------------------------------------------------

	async register(config: ServiceConfig): Promise<ServiceEntry> {
		const res = await this.#request({ type: "register", config });
		return res.data as ServiceEntry;
	}

	async deregister(alias: string): Promise<void> {
		await this.#request({ type: "deregister", alias });
	}

	async list(): Promise<ServiceEntry[]> {
		const res = await this.#request({ type: "list" });
		return (res.data as ServiceEntry[]) ?? [];
	}

	async status(alias?: string): Promise<unknown> {
		const res = await this.#request({ type: "status", alias });
		return res.data;
	}

	async cleanup(sessionId: string): Promise<{ removed: string[] }> {
		const res = await this.#request({ type: "cleanup", sessionId });
		return res.data as { removed: string[] };
	}

	async certInfo(): Promise<{ certPath: string; keyPath: string; caRoot: string | null }> {
		const res = await this.#request({ type: "cert_info" });
		return res.data as { certPath: string; keyPath: string; caRoot: string | null };
	}

	async health(): Promise<{ status: string; pid: number }> {
		const res = await this.#request({ type: "health" });
		return res.data as { status: string; pid: number };
	}

	/** Get the HTTPS URL for a given alias. */
	getAliasUrl(alias: string): string {
		return `https://${alias}.localhost`;
	}

	async dispose(): Promise<void> {
		this.#disposed = true;
		// Reject all pending requests
		for (const [_id, pending] of this.#pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Client disposed"));
		}
		this.#pending.clear();
		this.#disconnect();
	}

	// -----------------------------------------------------------------------
	// Connection management
	// -----------------------------------------------------------------------

	async #ensureConnected(): Promise<void> {
		if (this.#disposed) throw new Error("Gateway client is disposed");
		if (this.#connected && this.#socket && !this.#socket.destroyed) return;

		// Try direct connect first
		try {
			await this.#connect();
			return;
		} catch {
			// Connection failed
		}

		// Auto-spawn daemon if enabled
		if (this.#autoSpawn) {
			await this.#spawnDaemon();

			// Retry connect with backoff
			for (const delay of RECONNECT_DELAYS_MS) {
				await Bun.sleep(delay);
				try {
					await this.#connect();
					return;
				} catch {
					// Keep trying
				}
			}
		}

		throw new Error(`Cannot connect to gateway daemon at ${this.#socketPath}`);
	}

	#connect(): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();

		this.#disconnect();
		this.#buffer = "";

		const socket = net.createConnection(this.#socketPath);

		const timeout = setTimeout(() => {
			socket.destroy();
			reject(new Error("Connection timeout"));
		}, 5000);

		socket.on("connect", () => {
			clearTimeout(timeout);
			this.#socket = socket;
			this.#connected = true;
			this.#setupSocketHandlers(socket);
			resolve();
		});

		socket.on("error", err => {
			clearTimeout(timeout);
			reject(err);
		});

		return promise;
	}

	#setupSocketHandlers(socket: net.Socket): void {
		socket.on("data", (chunk: Buffer) => {
			this.#buffer += chunk.toString();
			for (;;) {
				const idx = this.#buffer.indexOf("\n");
				if (idx === -1) break;
				const line = this.#buffer.slice(0, idx);
				this.#buffer = this.#buffer.slice(idx + 1);
				this.#handleResponseLine(line);
			}
		});

		socket.on("close", () => {
			this.#connected = false;
			this.#socket = null;
		});

		socket.on("error", err => {
			logger.debug("[gateway-client] Socket error", { error: err.message });
			this.#connected = false;
		});
	}

	#handleResponseLine(line: string): void {
		const msg = parseMessage(line);
		if (!msg || !("id" in msg)) return;

		const response = msg as GatewayResponse;
		const pending = this.#pending.get(response.id);
		if (!pending) return;

		clearTimeout(pending.timer);
		this.#pending.delete(response.id);
		pending.resolve(response);
	}

	#disconnect(): void {
		if (this.#socket) {
			this.#socket.destroy();
			this.#socket = null;
		}
		this.#connected = false;
	}

	// -----------------------------------------------------------------------
	// Request/response
	// -----------------------------------------------------------------------

	async #request(
		params: DistributiveOmit<GatewayRequest, "id">,
	): Promise<GatewayResponse & { ok: true; data?: unknown }> {
		await this.#ensureConnected();

		const id = `req-${++this.#idCounter}`;
		const req = { ...params, id } as GatewayRequest;

		const { promise, resolve, reject } = Promise.withResolvers<GatewayResponse>();

		const timer = setTimeout(() => {
			this.#pending.delete(id);
			reject(new Error(`Request timeout after ${REQUEST_TIMEOUT_MS}ms: ${params.type}`));
		}, REQUEST_TIMEOUT_MS);

		this.#pending.set(id, { resolve, reject, timer });

		if (!this.#socket || this.#socket.destroyed) {
			this.#pending.delete(id);
			clearTimeout(timer);
			throw new Error("Socket not connected");
		}

		this.#socket.write(serializeMessage(req));

		const response = await promise;
		if (!response.ok) {
			const err = new Error(response.error) as Error & { code?: string };
			err.code = response.code;
			throw err;
		}

		return response as GatewayResponse & { ok: true; data?: unknown };
	}

	// -----------------------------------------------------------------------
	// Auto-spawn
	// -----------------------------------------------------------------------

	async #spawnDaemon(): Promise<void> {
		logger.debug("[gateway-client] Auto-spawning gateway daemon");

		// The daemon entry point
		const daemonPath = new URL("./daemon.ts", import.meta.url).pathname;

		const proc = Bun.spawn(["bun", daemonPath], {
			stdio: ["ignore", "ignore", "ignore"],
			env: process.env,
		});

		// Don't wait for the process, it runs as a daemon.
		// The connect retry loop will handle waiting for it to be ready.
		proc.unref();
	}
}

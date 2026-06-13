/**
 * MCP stdio transport.
 *
 * Implements JSON-RPC 2.0 over subprocess stdin/stdout.
 * Messages are newline-delimited JSON.
 */

import { getProjectDir, readJsonl, Snowflake } from "@spell/pi-utils";
import { type Subprocess, spawn } from "bun";
import type { JsonRpcResponse, MCPRequestOptions, MCPStdioServerConfig, MCPTransport } from "../../mcp/types";

/**
 * Stdio transport for MCP servers.
 * Spawns a subprocess and communicates via stdin/stdout.
 */
export class StdioTransport implements MCPTransport {
	#process: Subprocess<"pipe", "pipe", "pipe"> | null = null;
	#pendingRequests = new Map<
		string | number,
		{
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
		}
	>();
	#connected = false;
	#readLoop: Promise<void> | null = null;

	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	/**
	 * Handler for SERVER-INITIATED requests (e.g. `elicitation/create`). A
	 * server request carries both `id` and `method`; the transport replies on
	 * the same channel with the same `id` once this resolves.
	 */
	onServerRequest?: (
		method: string,
		params: unknown,
		id: string | number,
	) => Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }>;

	constructor(private config: MCPStdioServerConfig) {}

	get connected(): boolean {
		return this.#connected;
	}

	/**
	 * Start the subprocess and begin reading.
	 */
	async connect(): Promise<void> {
		if (this.#connected) return;

		const args = this.config.args ?? [];
		const env = {
			...Bun.env,
			...this.config.env,
		};

		this.#process = spawn({
			cmd: [this.config.command, ...args],
			cwd: this.config.cwd ?? getProjectDir(),
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});

		this.#connected = true;

		// Start reading stdout
		this.#readLoop = this.#startReadLoop();

		// Log stderr for debugging
		this.#startStderrLoop();
	}

	async #startReadLoop(): Promise<void> {
		if (!this.#process?.stdout) return;
		try {
			for await (const line of readJsonl(this.#process.stdout)) {
				if (!this.#connected) break;
				try {
					this.#handleMessage(line as JsonRpcResponse);
				} catch {
					// Skip malformed lines
				}
			}
		} catch (error) {
			if (this.#connected) {
				this.onError?.(error instanceof Error ? error : new Error(String(error)));
			}
		} finally {
			this.#handleClose();
		}
	}

	async #startStderrLoop(): Promise<void> {
		if (!this.#process?.stderr) return;

		const reader = this.#process.stderr.getReader();
		const decoder = new TextDecoder();

		try {
			while (this.#connected) {
				const { done, value } = await reader.read();
				if (done) break;
				// Log stderr but don't treat as error - servers use it for logging
				const text = decoder.decode(value, { stream: true });
				if (text.trim()) {
					// Could expose via onStderr callback if needed
					// For now, silent - MCP spec says clients MAY capture/ignore
				}
			}
		} catch {
			// Ignore stderr read errors
		} finally {
			reader.releaseLock();
		}
	}

	#handleMessage(message: JsonRpcResponse): void {
		// A SERVER-INITIATED request carries BOTH `id` and `method`. It must be
		// detected before the response branch (which keys only on `id`), else it
		// would be mistaken for a reply to one of our requests and dropped.
		if ("id" in message && message.id !== null && "method" in message) {
			const req = message as unknown as { id: string | number; method: string; params?: unknown };
			this.#handleServerRequest(req.method, req.params, req.id);
			return;
		}
		// Check if it's a response (has id)
		if ("id" in message && message.id !== null) {
			const pending = this.#pendingRequests.get(message.id);
			if (pending) {
				this.#pendingRequests.delete(message.id);
				if (message.error) {
					pending.reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`));
				} else {
					pending.resolve(message.result);
				}
			}
		} else if ("method" in message) {
			// It's a notification from server
			const notification = message as { method: string; params?: unknown };
			this.onNotification?.(notification.method, notification.params);
		}
	}

	/**
	 * Handle a server-initiated request: delegate to `onServerRequest`, then
	 * write the JSON-RPC reply back on stdin with the SAME id. If no handler is
	 * set, reply with a "method not found" error so the server is never left
	 * hanging.
	 */
	#handleServerRequest(method: string, params: unknown, id: string | number): void {
		const respond = (payload: { result?: unknown; error?: { code: number; message: string; data?: unknown } }) => {
			if (!this.#process?.stdin) return;
			const reply = { jsonrpc: "2.0" as const, id, ...payload };
			this.#process.stdin.write(`${JSON.stringify(reply)}\n`);
			this.#process.stdin.flush();
		};
		if (!this.onServerRequest) {
			respond({ error: { code: -32601, message: `Method not found: ${method}` } });
			return;
		}
		this.onServerRequest(method, params, id)
			.then(respond)
			.catch((err: unknown) => {
				respond({
					error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
				});
			});
	}

	#handleClose(): void {
		if (!this.#connected) return;
		this.#connected = false;

		// Reject all pending requests
		for (const [, pending] of this.#pendingRequests) {
			pending.reject(new Error("Transport closed"));
		}
		this.#pendingRequests.clear();

		this.onClose?.();
	}

	async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		if (!this.#connected || !this.#process?.stdin) {
			throw new Error("Transport not connected");
		}

		const id = Snowflake.next();
		const request = {
			jsonrpc: "2.0" as const,
			id,
			method,
			params: params ?? {},
		};

		const timeout = this.config.timeout ?? 30000;
		const signal = options?.signal;

		if (signal?.aborted) {
			const reason = signal.reason instanceof Error ? signal.reason : new Error("Aborted");
			return Promise.reject(reason);
		}

		const { promise, resolve, reject } = Promise.withResolvers<T>();
		let timer: NodeJS.Timeout | undefined;
		let settled = false;

		const cleanup = () => {
			if (settled) return;
			settled = true;
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			if (signal) {
				signal.removeEventListener("abort", onAbort);
			}
			this.#pendingRequests.delete(id);
		};

		const onAbort = () => {
			cleanup();
			const reason = signal?.reason instanceof Error ? signal.reason : new Error("Aborted");
			reject(reason);
		};

		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
		}

		this.#pendingRequests.set(id, {
			resolve: (value: unknown) => {
				cleanup();
				resolve(value as T);
			},
			reject: (error: Error) => {
				cleanup();
				reject(error);
			},
		});

		timer = setTimeout(() => {
			cleanup();
			reject(new Error(`Request timeout after ${timeout}ms`));
		}, timeout);

		const message = `${JSON.stringify(request)}\n`;
		try {
			// Bun's FileSink has write() method directly
			this.#process.stdin.write(message);
			this.#process.stdin.flush();
		} catch (error: unknown) {
			cleanup();
			reject(error instanceof Error ? error : new Error(String(error)));
		}

		return promise;
	}

	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		if (!this.#connected || !this.#process?.stdin) {
			throw new Error("Transport not connected");
		}

		const notification = {
			jsonrpc: "2.0" as const,
			method,
			params: params ?? {},
		};

		const message = `${JSON.stringify(notification)}\n`;
		// Bun's FileSink has write() method directly
		this.#process.stdin.write(message);
		this.#process.stdin.flush();
	}

	async close(): Promise<void> {
		if (!this.#connected) return;
		this.#connected = false;

		// Reject pending requests
		for (const [, pending] of this.#pendingRequests) {
			pending.reject(new Error("Transport closed"));
		}
		this.#pendingRequests.clear();

		// Kill subprocess
		if (this.#process) {
			this.#process.kill();
			this.#process = null;
		}

		// Wait for read loop to finish
		if (this.#readLoop) {
			await this.#readLoop.catch(() => {});
			this.#readLoop = null;
		}

		this.onClose?.();
	}
}

/**
 * Create and connect a stdio transport.
 */
export async function createStdioTransport(config: MCPStdioServerConfig): Promise<StdioTransport> {
	const transport = new StdioTransport(config);
	await transport.connect();
	return transport;
}

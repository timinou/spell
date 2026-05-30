import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { logger } from "@spell/pi-utils";
import type { Subprocess } from "bun";
import type { BridgeCommand, BridgeEvent } from "./protocol";

const HEARTBEAT_TIMEOUT_MS = 90_000;
const RECONNECT_DELAYS = [100, 200, 400, 800, 1600];

/** Sleep that doesn't keep the event loop alive. Resolves early if signal is aborted. */
function unrefSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, ms);
	if (typeof timer === "object" && "unref" in timer) (timer as NodeJS.Timeout).unref();
	if (signal) {
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal.addEventListener("abort", onAbort, { once: true });
		// Clean up listener once timer fires naturally.
		promise.then(() => signal.removeEventListener("abort", onAbort));
	}
	return promise;
}

/** Resolves the path to the compiled bridge binary. */
export function bridgeBinaryPath(): string {
	// Resolve relative to this file at runtime
	const dir = path.dirname(import.meta.path);
	const packageRoot = path.resolve(dir, "..");
	return path.join(packageRoot, "native", "spell-qml-bridge");
}

/** Returns true if the bridge binary exists and is executable. */
export function isBridgeAvailable(binary = bridgeBinaryPath()): boolean {
	try {
		fs.accessSync(binary, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export type EventListener = (event: BridgeEvent) => void;

export interface QmlProcessOptions {
	/** Extra environment variables merged with process.env for the bridge process. */
	env?: Record<string, string>;
	/** Optional bridge binary override (primarily for tests). */
	binaryPath?: string;
	/** Override heartbeat staleness timeout in ms (default: 90000). Primarily for tests. */
	heartbeatTimeoutMs?: number;
}

/**
 * Manages a single long-lived bridge subprocess.
 * Supports two modes:
 * - stdio: spawns child process, communicates via stdin/stdout (used by QML tool)
 * - socket: connects to a daemon via unix domain socket (used by desktop mode)
 */
export class QmlProcess {
	#binaryPath: string;
	#env: Record<string, string> | undefined;
	#resolvedSocketPath: string | null = null;
	#proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
	#stdin: Bun.FileSink | null = null;
	#socket: net.Socket | null = null;
	#socketBuffer = "";
	#listeners: Set<EventListener> = new Set();
	#pendingReconnectState: BridgeEvent | null = null;
	#buffer = "";
	#stderrBuffer = "";
	#stopping = false;
	#intentionalDisconnect = false;
	#connectingPromise: Promise<"existing" | "new"> | null = null;
	#reconnectPromise: Promise<void> | null = null;
	#reconnectAbort: AbortController | null = null;
	#lastDataReceived = Date.now();
	#heartbeatTimeoutMs: number;

	constructor(options?: QmlProcessOptions) {
		this.#env = options?.env;
		this.#binaryPath = options?.binaryPath ?? bridgeBinaryPath();
		this.#heartbeatTimeoutMs = options?.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
	}

	/** Returns the unix socket path for daemon mode. */
	static socketPath(): string {
		const runtime = process.env.XDG_RUNTIME_DIR;
		if (runtime) return path.join(runtime, "spell-qml-bridge.sock");
		return `/tmp/spell-qml-bridge-${process.getuid?.() ?? 0}.sock`;
	}

	/** Returns the lock file path used to prevent concurrent daemon spawns. */
	static lockPath(): string {
		return `${QmlProcess.socketPath()}.lock`;
	}

	/** Instance-level lock path: uses resolved socket path when available. */
	#lockPath(): string {
		const base = this.#resolvedSocketPath ?? QmlProcess.socketPath();
		return `${base}.lock`;
	}

	/** Timestamp of the last data received on the socket (heartbeat or event). */
	get lastDataReceived(): number {
		return this.#lastDataReceived;
	}

	/** Spawn or connect to the bridge. */
	async ensure(): Promise<"existing" | "new"> {
		// Already connected via socket
		if (this.#socket && !this.#socket.destroyed) {
			// Stale detection: if no data received for 3 missed heartbeats, treat as dead.
			if (Date.now() - this.#lastDataReceived > this.#heartbeatTimeoutMs) {
				logger.warn("Socket appears stale (no data for 90s), forcing reconnect");
				// Suppress close handler's auto-reconnect — we'll reconnect via #doEnsure.
				this.#intentionalDisconnect = true;
				this.#socket.destroy();
				this.#socket = null;
				// Fall through to reconnect logic below
			} else {
				return "existing";
			}
		}
		// Already running as child process
		if (this.#proc && this.#proc.exitCode === null) return "new";
		if (this.#stopping) throw new Error("QmlProcess is shutting down");

		// Concurrency guard: if another caller is already connecting, share the promise.
		if (this.#connectingPromise) return this.#connectingPromise;

		this.#connectingPromise = this.#doEnsure();
		try {
			return await this.#connectingPromise;
		} finally {
			this.#connectingPromise = null;
		}
	}

	async #doEnsure(): Promise<"existing" | "new"> {
		// Try daemon socket first, fall back to spawning
		try {
			await this.#connectSocket();
			return "existing";
		} catch {
			// Socket not available — try spawning daemon then connecting
		}

		await this.#spawnDaemon();
		return "new";
	}

	/** Spawn the bridge in daemon mode, then connect via socket. */
	async #spawnDaemon(): Promise<void> {
		const binary = this.#binaryPath;
		if (!isBridgeAvailable(binary)) {
			throw new Error(
				`spell-qml-bridge binary not found at ${binary}.\n` +
					`Build it first: cd packages/qml && bun run build:bridge`,
			);
		}

		// Acquire spawn lock to prevent concurrent daemon starts.
		const lockAcquired = await this.#acquireSpawnLock();
		try {
			// If the lock was contended (another process held it), they may have
			// already spawned a daemon. Retry connecting before spawning a new one.
			if (!lockAcquired) {
				try {
					await this.#connectSocket();
					return;
				} catch {
					// Still no daemon — proceed to spawn.
				}
			}

			// Spawn daemon — capture stderr for diagnostics if connection fails.
			const daemonProc = Bun.spawn([binary, "--daemon"], {
				stdin: "ignore",
				stdout: "ignore",
				stderr: "pipe",
				env: this.#env ? { ...process.env, ...this.#env } : undefined,
			});

			// Retry connect with exponential backoff
			const delays = [100, 200, 400, 500];
			let lastError: Error | undefined;
			for (const delay of delays) {
				await unrefSleep(delay);
				try {
					await this.#connectSocket();
					// Release stderr pipe so daemon isn't blocked by full buffer
					void daemonProc.stderr.cancel().catch(() => {});
					return;
				} catch (err) {
					lastError = err instanceof Error ? err : new Error(String(err));
				}
			}

			// Connection failed — drain daemon stderr for diagnostics
			const stderrText = await this.#drainStderrBounded(daemonProc.stderr, 200, 50);
			const stderrSuffix = stderrText ? `\nDaemon stderr:\n${stderrText}` : "";
			throw new Error(
				`Failed to connect to daemon socket after spawn: ${lastError?.message ?? "unknown error"}${stderrSuffix}`,
			);
		} finally {
			this.#releaseSpawnLock();
		}
	}

	/** Read up to `maxLines` from a stderr stream with a timeout. */
	async #drainStderrBounded(stream: ReadableStream<Uint8Array>, timeoutMs: number, maxLines: number): Promise<string> {
		const reader = stream.getReader();
		const chunks: string[] = [];
		const decoder = new TextDecoder();
		try {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const remaining = deadline - Date.now();
				if (remaining <= 0) break;
				const result = await Promise.race([reader.read(), Bun.sleep(remaining).then(() => null)]);
				if (!result || result.done) break;
				chunks.push(decoder.decode(result.value, { stream: true }));
			}
		} catch {
			// Stream may be closed or errored
		} finally {
			await reader.cancel().catch(() => {});
		}
		const text = chunks.join("").trim();
		const lines = text.split("\n");
		return lines.slice(-maxLines).join("\n");
	}

	/** Spawn the bridge as a child process with stdio pipes (legacy mode). */
	async spawnStdio(): Promise<void> {
		if (this.#proc && this.#proc.exitCode === null) return;
		if (this.#stopping) throw new Error("QmlProcess is shutting down");

		const binary = this.#binaryPath;
		if (!isBridgeAvailable(binary)) {
			throw new Error(
				`spell-qml-bridge binary not found at ${binary}.\n` +
					`Build it first: cd packages/qml && bun run build:bridge`,
			);
		}

		const proc = Bun.spawn([binary], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: this.#env ? { ...process.env, ...this.#env } : undefined,
		});
		this.#proc = proc;
		this.#stdin = proc.stdin;

		// Read stdout line by line (bridge JSON protocol)
		this.#readLoop(this.#proc.stdout as ReadableStream<Uint8Array>).catch(err => {
			logger.error("QmlProcess stdout read error", { error: String(err) });
		});

		// Read stderr and forward as synthetic error events
		this.#readStderr(this.#proc.stderr as ReadableStream<Uint8Array>).catch(err => {
			logger.error("QmlProcess stderr read error", { error: String(err) });
		});

		// Log unexpected exit
		this.#proc.exited.then(code => {
			if (!this.#stopping) {
				logger.warn("spell-qml-bridge exited unexpectedly", { code });
			}
		});

		logger.debug("spell-qml-bridge spawned (stdio mode)", { binary });
	}

	/**
	 * Connect to the daemon's unix domain socket.
	 * Rejects if connection fails within 5 seconds.
	 */
	#connectSocket(signal?: AbortSignal): Promise<void> {
		if (this.#stopping) return Promise.reject(new Error("QmlProcess is shutting down"));
		if (signal?.aborted) return Promise.reject(new Error("Aborted"));
		// Capture socket path on first connect; reuse for auto-reconnect so it
		// doesn't read a stale/overridden static value after the caller restores it.
		if (!this.#resolvedSocketPath) this.#resolvedSocketPath = QmlProcess.socketPath();
		const socketPath = this.#resolvedSocketPath;
		const { promise, resolve, reject } = Promise.withResolvers<void>();

		const socket = net.createConnection(socketPath);
		// Unref so in-flight connections don't prevent process exit during test teardown.
		socket.unref();
		const timeout = setTimeout(() => {
			socket.destroy();
			reject(new Error("Socket connection timed out (5s)"));
		}, 5000);
		if (typeof timeout === "object" && "unref" in timeout) timeout.unref();

		// Abort handler: immediately kill the connection attempt.
		const onAbort = () => {
			clearTimeout(timeout);
			socket.destroy();
			reject(new Error("Connection aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		socket.on("connect", () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			socket.ref(); // Re-ref so the active connection keeps the process alive.
			this.#socket = socket;
			this.#socketBuffer = "";

			// Buffer the first state event so reconnect() can consume it
			// without racing against #dispatch delivering it to other listeners.
			this.#pendingReconnectState = null;
			const captureState = (event: BridgeEvent) => {
				if (event.type === "state") {
					this.#pendingReconnectState = event;
					this.#listeners.delete(captureState);
				}
			};
			this.#listeners.add(captureState);

			logger.debug("Connected to spell-qml-bridge daemon", { socketPath });
			resolve();
		});

		socket.on("error", (err: NodeJS.ErrnoException) => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			socket.destroy();
			reject(err);
		});

		socket.on("data", (chunk: Buffer) => {
			this.#lastDataReceived = Date.now();
			this.#socketBuffer += chunk.toString("utf8");
			for (;;) {
				const nl = this.#socketBuffer.indexOf("\n");
				if (nl < 0) break;
				const line = this.#socketBuffer.slice(0, nl).trim();
				this.#socketBuffer = this.#socketBuffer.slice(nl + 1);
				if (line) this.#dispatch(line);
			}
		});

		socket.on("close", () => {
			const wasUnexpected = !this.#stopping && !this.#intentionalDisconnect;
			this.#intentionalDisconnect = false;
			if (wasUnexpected) {
				logger.warn("Daemon socket closed unexpectedly");
				// Dispatch synthetic event before nulling socket so listeners see it.
				this.#dispatchEvent({
					type: "socket_disconnected",
					id: "__socket__",
					message: "Daemon socket closed unexpectedly",
				});
			}
			this.#socket = null;
			if (wasUnexpected) {
				this.#reconnectAbort = new AbortController();
				this.#reconnectPromise = this.#autoReconnect(this.#reconnectAbort.signal).finally(() => {
					this.#reconnectPromise = null;
					this.#reconnectAbort = null;
				});
			}
		});

		return promise;
	}

	async #readLoop(stream: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		const reader = stream.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				this.#buffer += decoder.decode(value, { stream: true });
				for (;;) {
					const nl = this.#buffer.indexOf("\n");
					if (nl < 0) break;
					const line = this.#buffer.slice(0, nl).trim();
					this.#buffer = this.#buffer.slice(nl + 1);
					if (line) this.#dispatch(line);
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	/**
	 * Read stderr line-by-line and dispatch as synthetic error events.
	 * Lines are broadcast to all listeners as `{ type: "error", id: "__stderr__", message }`,
	 * allowing the QmlBridge to forward them to the agent.
	 */
	async #readStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		const reader = stream.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				this.#stderrBuffer += decoder.decode(value, { stream: true });
				for (;;) {
					const nl = this.#stderrBuffer.indexOf("\n");
					if (nl < 0) break;
					const line = this.#stderrBuffer.slice(0, nl).trim();
					this.#stderrBuffer = this.#stderrBuffer.slice(nl + 1);
					if (line) {
						const event: BridgeEvent = { type: "error", id: "__stderr__", message: line };
						for (const listener of this.#listeners) {
							try {
								listener(event);
							} catch (err) {
								logger.error("QmlProcess stderr listener threw", { error: String(err) });
							}
						}
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	#dispatch(line: string): void {
		let event: BridgeEvent;
		try {
			event = JSON.parse(line) as BridgeEvent;
		} catch {
			logger.warn("spell-qml-bridge: invalid JSON line", { line });
			return;
		}
		this.#dispatchEvent(event);
	}

	/** Dispatch a pre-parsed event to all listeners. Used for synthetic events. */
	#dispatchEvent(event: BridgeEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch (err) {
				logger.error("QmlProcess synthetic event listener threw", { error: String(err) });
			}
		}
	}

	/** Auto-reconnect to daemon with exponential backoff after unexpected disconnect. */
	async #autoReconnect(signal: AbortSignal): Promise<void> {
		for (const delay of RECONNECT_DELAYS) {
			if (this.#stopping || signal.aborted) return;
			await unrefSleep(delay, signal);
			if (this.#stopping || signal.aborted) return;
			try {
				await this.#connectSocket(signal);
				logger.debug("Auto-reconnect to daemon succeeded");
				return;
			} catch {
				if (signal.aborted) return;
				logger.debug("Auto-reconnect attempt failed", { nextDelay: delay * 2 });
			}
		}
		logger.warn("Auto-reconnect exhausted all attempts");
	}

	/**
	 * Acquire a mkdir-based filesystem lock for daemon spawn.
	 * Returns true if the lock was acquired (we should proceed to spawn),
	 * false if we waited for the lock and should retry connecting.
	 */
	async #acquireSpawnLock(): Promise<boolean> {
		const lockDir = this.#lockPath();
		const maxRetries = 3;
		const retryDelay = 200;
		const staleTimeout = 10_000;

		for (let i = 0; i < maxRetries; i++) {
			try {
				await fsp.mkdir(lockDir, { recursive: false });
				return true; // Lock acquired
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				// ENOENT: parent directory was deleted (test cleanup). Skip lock.
				if (code === "ENOENT") return false;
				if (code !== "EEXIST") throw err;
				// Lock exists — check staleness
				try {
					const stat = await fsp.stat(lockDir);
					if (Date.now() - stat.mtimeMs > staleTimeout) {
						// Stale lock — remove and retry
						await fsp.rmdir(lockDir).catch(() => {});
						continue;
					}
				} catch {
					// Lock dir disappeared between exists and stat — retry
					continue;
				}
				// Lock is held by another process — wait and retry connect
				await unrefSleep(retryDelay * (i + 1));
			}
		}
		// Couldn't acquire after retries — proceed without lock (best effort)
		return false;
	}

	/** Release the spawn lock directory. */
	#releaseSpawnLock(): void {
		const lockDir = this.#lockPath();
		try {
			fs.rmdirSync(lockDir);
		} catch {
			// Lock may have been released by timeout cleanup
		}
	}

	/** Consume the state event buffered during socket connect. Returns null if none buffered. */
	takeReconnectState(): BridgeEvent | null {
		const state = this.#pendingReconnectState;
		this.#pendingReconnectState = null;
		return state;
	}

	/** Send a command to the bridge. Caller must have called ensure() first. */
	send(command: BridgeCommand): void {
		const line = `${JSON.stringify(command)}\n`;

		if (this.#socket) {
			if (!this.#socket.writable) {
				throw new Error("Daemon socket is not writable");
			}
			this.#socket.write(line);
			return;
		}

		if (!this.#stdin) throw new Error("Bridge not running");
		this.#stdin.write(line);
		this.#stdin.flush();
	}

	addListener(fn: EventListener): () => void {
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}

	/** Wait for a specific event type and window id (resolves on first match). */
	waitFor(predicate: (event: BridgeEvent) => boolean, timeoutMs = 10_000): Promise<BridgeEvent> {
		const { promise, resolve, reject } = Promise.withResolvers<BridgeEvent>();
		const timer = setTimeout(() => {
			remove();
			reject(new Error("Timed out waiting for bridge event"));
		}, timeoutMs);
		const remove = this.addListener(event => {
			if (predicate(event)) {
				clearTimeout(timer);
				remove();
				resolve(event);
			}
		});
		return promise;
	}

	/** Gracefully shut down the bridge process (stdio mode) or disconnect (daemon mode). */
	async dispose(): Promise<void> {
		this.#stopping = true;
		this.#listeners.clear(); // Prevent any further event dispatching.

		if (this.#socket) {
			this.#socket.destroy();
			this.#socket = null;
		}

		// Abort and wait for any in-flight auto-reconnect to exit.
		this.#reconnectAbort?.abort();
		if (this.#reconnectPromise) {
			await this.#reconnectPromise.catch(() => {});
		}

		if (this.#proc) {
			try {
				this.#stdin?.end();
				this.#stdin = null;
				await Promise.race([
					this.#proc.exited,
					Bun.sleep(2000).then(() => {
						this.#proc?.kill();
					}),
				]);
			} catch {
				this.#proc?.kill();
			}
		}
	}

	/** Send quit command to daemon and disconnect. */
	async kill(): Promise<void> {
		if (this.#socket?.writable) {
			this.send({ type: "quit" });
			// Brief delay to let the quit flush
			await Bun.sleep(100);
		}
		this.#reconnectAbort?.abort();
		this.#stopping = true;
		if (this.#socket) {
			this.#socket.destroy();
			this.#socket = null;
		}
		if (this.#reconnectPromise) {
			await this.#reconnectPromise.catch(() => {});
		}
	}

	/** True if connected via unix domain socket (daemon mode). */
	get isDaemon(): boolean {
		return this.#socket !== null && !this.#socket.destroyed;
	}

	get isRunning(): boolean {
		if (this.#socket && !this.#socket.destroyed) return true;
		return this.#proc !== null && this.#proc.exitCode === null;
	}
}

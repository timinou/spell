import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import type { BridgeCommand, BridgeEvent } from "./protocol";

/** Resolves the path to the compiled bridge binary. */
export function bridgeBinaryPath(): string {
	// Resolve relative to this file at runtime
	const dir = path.dirname(import.meta.path);
	const packageRoot = path.resolve(dir, "..");
	return path.join(packageRoot, "native", "spell-qml-bridge");
}

/** Returns true if the bridge binary exists and is executable. */
export function isBridgeAvailable(): boolean {
	try {
		fs.accessSync(bridgeBinaryPath(), fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export type EventListener = (event: BridgeEvent) => void;

/**
 * Manages a single long-lived bridge subprocess.
 * Supports two modes:
 * - stdio: spawns child process, communicates via stdin/stdout (used by QML tool)
 * - socket: connects to a daemon via unix domain socket (used by desktop mode)
 */
export class QmlProcess {
	#proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
	#stdin: Bun.FileSink | null = null;
	#socket: net.Socket | null = null;
	#socketBuffer = "";
	#listeners: Set<EventListener> = new Set();
	#buffer = "";
	#stderrBuffer = "";
	#stopping = false;

	/** Returns the unix socket path for daemon mode. */
	static socketPath(): string {
		const runtime = process.env.XDG_RUNTIME_DIR;
		if (runtime) return path.join(runtime, "spell-qml-bridge.sock");
		return `/tmp/spell-qml-bridge-${process.getuid?.() ?? 0}.sock`;
	}

	/** Spawn or connect to the bridge. */
	async ensure(): Promise<void> {
		// Already connected via socket
		if (this.#socket && !this.#socket.destroyed) return;
		// Already running as child process
		if (this.#proc && this.#proc.exitCode === null) return;
		if (this.#stopping) throw new Error("QmlProcess is shutting down");

		// Try daemon socket first, fall back to spawning
		try {
			await this.#connectSocket();
			return;
		} catch {
			// Socket not available — try spawning daemon then connecting
		}

		await this.#spawnDaemon();
	}

	/** Spawn the bridge in daemon mode, then connect via socket. */
	async #spawnDaemon(): Promise<void> {
		const binary = bridgeBinaryPath();
		if (!isBridgeAvailable()) {
			throw new Error(
				`spell-qml-bridge binary not found at ${binary}.\n` +
					`Build it first: cd packages/qml && bun run build:bridge`,
			);
		}

		// Spawn daemon process — stdio ignored since it communicates via socket.
		// Use "ignore" to prevent pipe buffer blocking on daemon stderr output.
		Bun.spawn([binary, "--daemon"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});

		// Retry connect with exponential backoff
		const delays = [100, 200, 400, 500];
		let lastError: Error | undefined;
		for (const delay of delays) {
			await Bun.sleep(delay);
			try {
				await this.#connectSocket();
				return;
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));
			}
		}
		// Failed to connect after all retries
		throw new Error(`Failed to connect to daemon socket after spawn: ${lastError?.message ?? "unknown error"}`);
	}

	/** Spawn the bridge as a child process with stdio pipes (legacy mode). */
	async spawnStdio(): Promise<void> {
		if (this.#proc && this.#proc.exitCode === null) return;
		if (this.#stopping) throw new Error("QmlProcess is shutting down");

		const binary = bridgeBinaryPath();
		if (!isBridgeAvailable()) {
			throw new Error(
				`spell-qml-bridge binary not found at ${binary}.\n` +
					`Build it first: cd packages/qml && bun run build:bridge`,
			);
		}

		const proc = Bun.spawn([binary], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
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
	#connectSocket(): Promise<void> {
		const socketPath = QmlProcess.socketPath();
		const { promise, resolve, reject } = Promise.withResolvers<void>();

		const socket = net.createConnection(socketPath);
		const timeout = setTimeout(() => {
			socket.destroy();
			reject(new Error("Socket connection timed out (5s)"));
		}, 5000);

		socket.on("connect", () => {
			clearTimeout(timeout);
			this.#socket = socket;
			this.#socketBuffer = "";
			logger.debug("Connected to spell-qml-bridge daemon", { socketPath });
			resolve();
		});

		socket.on("error", (err: NodeJS.ErrnoException) => {
			clearTimeout(timeout);
			socket.destroy();
			reject(err);
		});

		socket.on("data", (chunk: Buffer) => {
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
			if (!this.#stopping) {
				logger.warn("Daemon socket closed unexpectedly");
			}
			this.#socket = null;
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
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch (err) {
				logger.error("QmlProcess event listener threw", { error: String(err) });
			}
		}
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

		if (this.#socket) {
			this.#socket.destroy();
			this.#socket = null;
			return;
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
		this.#stopping = true;
		if (this.#socket) {
			this.#socket.destroy();
			this.#socket = null;
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

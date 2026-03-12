import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { BridgeCommand, BridgeEvent } from "./protocol";

/** Resolves the path to the compiled bridge binary. */
export function bridgeBinaryPath(): string {
	// Resolve relative to this file at runtime
	const dir = path.dirname(import.meta.path);
	const packageRoot = path.resolve(dir, "..");
	return path.join(packageRoot, "native", "omp-qml-bridge");
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
 * Spawns on demand, respawns if it dies unexpectedly.
 */
export class QmlProcess {
	#proc: ReturnType<typeof Bun.spawn> | null = null;
	#stdin: Bun.FileSink | null = null;
	#listeners: Set<EventListener> = new Set();
	#buffer = "";
	#stderrBuffer = "";
	#stopping = false;

	/** Spawn the bridge if not already running. */
	async ensure(): Promise<void> {
		if (this.#proc && this.#proc.exitCode === null) return;
		if (this.#stopping) throw new Error("QmlProcess is shutting down");
		await this.#spawn();
	}

	async #spawn(): Promise<void> {
		const binary = bridgeBinaryPath();
		if (!isBridgeAvailable()) {
			throw new Error(
				`omp-qml-bridge binary not found at ${binary}.\n` +
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

		// Respawn on unexpected exit
		this.#proc.exited.then(code => {
			if (!this.#stopping) {
				logger.warn("omp-qml-bridge exited unexpectedly", { code });
			}
		});

		logger.debug("omp-qml-bridge spawned", { binary });
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
			logger.warn("omp-qml-bridge: invalid JSON line", { line });
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
		if (!this.#stdin) throw new Error("Bridge not running");
		const line = `${JSON.stringify(command)}\n`;
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

	/** Gracefully shut down the bridge process. */
	async dispose(): Promise<void> {
		this.#stopping = true;
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

	get isRunning(): boolean {
		return this.#proc !== null && this.#proc.exitCode === null;
	}
}

import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { FileSink, Subprocess } from "bun";
import type { BridgeRpcCommand, ImageContentRef, RpcEvent, RpcSpawnOptions } from "./types";

const READY_TIMEOUT_MS = 30_000;
const PROMPT_TIMEOUT_MS = 5 * 60_000;

type RpcEventListener = (event: RpcEvent) => void;

interface RpcClientDependencies {
	command?: string;
	spawn?: typeof Bun.spawn;
}

interface PromptCompletion {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: Error) => void;
	timer: Timer;
}

interface ReadyWaiter {
	resolve: () => void;
	reject: (error: Error) => void;
	settled: boolean;
}

function isRpcEvent(value: unknown): value is RpcEvent {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return typeof record.type === "string";
}

export class RpcClient {
	#options: RpcSpawnOptions;
	#process: Subprocess | null = null;
	#eventListeners: RpcEventListener[] = [];
	#alive = false;
	#stdoutBuffer = "";
	#readyWaiter: ReadyWaiter | null = null;
	#promptQueue: Promise<void> = Promise.resolve();
	#pendingPromptCompletion: PromptCompletion | null = null;
	#closed = false;
	#command: string;
	#spawn: typeof Bun.spawn;

	constructor(options: RpcSpawnOptions, dependencies: RpcClientDependencies = {}) {
		this.#options = options;
		this.#command = dependencies.command ?? "spell";
		this.#spawn = dependencies.spawn ?? Bun.spawn;
	}

	get alive(): boolean {
		return this.#alive;
	}

	async start(): Promise<void> {
		if (this.#process || this.#alive) {
			throw new Error("RPC client is already started");
		}

		const args = ["--mode", "rpc", "--tools", this.#options.tools.join(",")];
		if (this.#options.sessionPath) {
			args.push("--resume", this.#options.sessionPath);
		}
		if (this.#options.sessionDir) {
			args.push("--session-dir", this.#options.sessionDir);
		}
		if (this.#options.noSession) {
			args.push("--no-session");
		}
		if (this.#options.appendSystemPrompt) {
			args.push("--append-system-prompt", this.#options.appendSystemPrompt);
		}

		let child: Subprocess;
		try {
			child = this.#spawn([this.#command, ...args], {
				cwd: this.#options.cwd,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch (error) {
			if (isEnoent(error)) {
				throw new Error(`Failed to spawn spell RPC process: binary '${this.#command}' was not found in PATH`);
			}
			throw new Error(`Failed to spawn spell RPC process: ${String(error)}`);
		}

		if (!child.stdin || !child.stdout || !child.stderr) {
			try {
				child.kill();
			} catch {
				// Best effort cleanup.
			}
			throw new Error("Failed to spawn spell RPC process with piped stdio");
		}

		this.#process = child;
		this.#alive = true;
		this.#closed = false;
		this.#stdoutBuffer = "";

		const ready = Promise.withResolvers<void>();
		this.#readyWaiter = {
			resolve: ready.resolve,
			reject: ready.reject,
			settled: false,
		};

		this.#consumeStdout(child.stdout as ReadableStream<Uint8Array>);
		this.#consumeStderr(child.stderr as ReadableStream<Uint8Array>);

		void child.exited
			.then(code => {
				this.#markDead(`RPC process exited with code ${code}`);
			})
			.catch(error => {
				this.#markDead(`RPC process exit monitoring failed: ${String(error)}`);
			});

		const timeoutTimer = setTimeout(() => {
			if (!this.#readyWaiter || this.#readyWaiter.settled) return;
			this.#readyWaiter.settled = true;
			this.#readyWaiter.reject(new Error("Timed out waiting for spell RPC ready event"));
			void this.kill();
		}, READY_TIMEOUT_MS);
		if ("unref" in timeoutTimer) {
			(timeoutTimer as NodeJS.Timeout).unref();
		}

		try {
			await ready.promise;
		} finally {
			clearTimeout(timeoutTimer);
		}
	}

	send(command: BridgeRpcCommand): void {
		const child = this.#process;
		if (!child?.stdin || !this.#alive) {
			throw new Error("Cannot send RPC command: process is not running");
		}

		const sink = child.stdin as FileSink;
		const payload = `${JSON.stringify(command)}\n`;

		try {
			sink.write(payload);
			const flushResult = sink.flush();
			if (flushResult instanceof Promise) {
				void flushResult.catch(error => {
					this.#markDead(`RPC stdin flush failed: ${String(error)}`);
				});
			}
		} catch (error) {
			const message = `RPC stdin write failed: ${String(error)}`;
			this.#markDead(message);
			throw new Error(message);
		}
	}

	onEvent(callback: (event: RpcEvent) => void): void {
		this.#eventListeners.push(callback);
	}

	async prompt(message: string, images?: ImageContentRef[]): Promise<void> {
		const task = this.#promptQueue.then(async () => {
			if (!this.#alive) {
				throw new Error("Cannot send prompt: RPC process is not running");
			}

			const completion = this.#createPromptCompletion();
			try {
				this.send({ type: "prompt", message, images });
			} catch (error) {
				this.#clearPromptCompletion();
				throw error;
			}
			await completion.promise;
		});

		this.#promptQueue = task.catch(() => {});
		await task;
	}

	async abort(): Promise<void> {
		this.send({ type: "abort" });
	}

	async kill(): Promise<void> {
		const child = this.#process;
		if (!child) {
			this.#alive = false;
			return;
		}

		try {
			child.kill();
		} catch (error) {
			logger.warn("Failed to kill RPC process", { error: String(error) });
		}

		try {
			await child.exited;
		} catch {
			// Process already terminated.
		}
	}

	#createPromptCompletion(): PromptCompletion {
		if (this.#pendingPromptCompletion) {
			throw new Error("Invariant violation: prompt completion already pending");
		}

		const deferred = Promise.withResolvers<void>();
		const timer = setTimeout(() => {
			const pending = this.#pendingPromptCompletion;
			if (!pending) return;
			this.#pendingPromptCompletion = null;
			pending.reject(new Error("Timed out waiting for prompt completion"));
		}, PROMPT_TIMEOUT_MS);
		if ("unref" in timer) {
			(timer as NodeJS.Timeout).unref();
		}

		const completion: PromptCompletion = {
			promise: deferred.promise,
			resolve: deferred.resolve,
			reject: deferred.reject,
			timer,
		};
		this.#pendingPromptCompletion = completion;
		return completion;
	}

	#resolvePromptCompletion(): void {
		const pending = this.#pendingPromptCompletion;
		if (!pending) return;
		this.#pendingPromptCompletion = null;
		clearTimeout(pending.timer);
		pending.resolve();
	}

	#clearPromptCompletion(error?: Error): void {
		const pending = this.#pendingPromptCompletion;
		if (!pending) return;
		this.#pendingPromptCompletion = null;
		clearTimeout(pending.timer);
		if (error) {
			pending.reject(error);
		}
	}

	#consumeStdout(stream: ReadableStream<Uint8Array>): void {
		const decoder = new TextDecoder();
		void (async () => {
			for await (const chunk of stream) {
				this.#processStdoutChunk(decoder.decode(chunk, { stream: true }));
			}
			this.#processStdoutChunk(decoder.decode());
			if (this.#stdoutBuffer.trim()) {
				this.#handleStdoutLine(this.#stdoutBuffer.trim());
				this.#stdoutBuffer = "";
			}
			this.#markDead("RPC stdout closed");
		})().catch(error => {
			this.#markDead(`RPC stdout reader failed: ${String(error)}`);
		});
	}

	#processStdoutChunk(chunk: string): void {
		this.#stdoutBuffer += chunk;
		let nextNewline = this.#stdoutBuffer.indexOf("\n");
		while (nextNewline !== -1) {
			const rawLine = this.#stdoutBuffer.slice(0, nextNewline);
			this.#stdoutBuffer = this.#stdoutBuffer.slice(nextNewline + 1);
			const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
			this.#handleStdoutLine(line);
			nextNewline = this.#stdoutBuffer.indexOf("\n");
		}
	}

	#handleStdoutLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch (error) {
			logger.warn("Skipping invalid RPC JSON line", { error: String(error), line: trimmed });
			return;
		}

		if (!isRpcEvent(parsed)) {
			logger.warn("Skipping unexpected RPC event shape", { payload: parsed });
			return;
		}

		if (parsed.type === "ready") {
			if (this.#readyWaiter && !this.#readyWaiter.settled) {
				this.#readyWaiter.settled = true;
				this.#readyWaiter.resolve();
			}
		}

		if (parsed.type === "agent_end" || parsed.type === "turn_end") {
			this.#resolvePromptCompletion();
		}

		this.#emitEvent(parsed);
	}

	#consumeStderr(stream: ReadableStream<Uint8Array>): void {
		const decoder = new TextDecoder();
		void (async () => {
			for await (const chunk of stream) {
				const text = decoder.decode(chunk, { stream: true }).trim();
				if (text) {
					logger.debug("[telegram-bridge:rpc] stderr", { text });
				}
			}
		})().catch(error => {
			logger.warn("RPC stderr reader failed", { error: String(error) });
		});
	}

	#emitEvent(event: RpcEvent): void {
		for (const listener of this.#eventListeners) {
			try {
				listener(event);
			} catch (error) {
				logger.warn("RPC event listener threw", { error: String(error) });
			}
		}
	}

	#markDead(reason: string): void {
		if (!this.#alive && this.#process === null) return;

		this.#alive = false;
		this.#process = null;

		if (this.#readyWaiter && !this.#readyWaiter.settled) {
			this.#readyWaiter.settled = true;
			this.#readyWaiter.reject(new Error(reason));
		}
		this.#readyWaiter = null;

		this.#clearPromptCompletion(new Error(reason));

		if (this.#closed) return;
		this.#closed = true;
		this.#emitEvent({ type: "error", message: reason });
	}
}

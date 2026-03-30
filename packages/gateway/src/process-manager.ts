/**
 * Managed backend process lifecycle — spawn, health check, auto-restart, graceful shutdown.
 *
 * Each ManagedBackend tracks a single child process for a gateway service.
 * Exponential backoff between restart attempts (100ms, 200ms, 400ms, ..., cap 30s).
 */
import { logger } from "@oh-my-pi/pi-utils";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { isPidRunning, terminate } from "@oh-my-pi/pi-utils/procmgr";
import type { Subprocess } from "bun";
import type { ManagedProcessConfig } from "./protocol";

const INITIAL_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 30_000;
const HEALTH_CHECK_INTERVAL_MS = 5_000;
const MAX_HEALTH_FAILURES = 3;
const SHUTDOWN_TIMEOUT_MS = 3_000;

export interface ManagedBackendState {
	pid: number | undefined;
	alive: boolean;
	restarts: number;
	lastStartedAt?: string;
}

export class ManagedBackend {
	#config: ManagedProcessConfig;
	#proc: Subprocess | null = null;
	#alive = false;
	#stopped = false;
	#restarts = 0;
	#backoffMs = INITIAL_BACKOFF_MS;
	#healthTimer?: Timer;
	#healthFailures = 0;
	#cancelPostmortem?: () => void;
	#lastStartedAt?: string;
	#autoRestart: boolean;

	constructor(config: ManagedProcessConfig, autoRestart = true) {
		this.#config = config;
		this.#autoRestart = autoRestart;
	}

	get pid(): number | undefined {
		return this.#proc?.pid;
	}

	get alive(): boolean {
		return this.#alive;
	}

	get state(): ManagedBackendState {
		return {
			pid: this.pid,
			alive: this.#alive,
			restarts: this.#restarts,
			lastStartedAt: this.#lastStartedAt,
		};
	}

	async start(): Promise<void> {
		if (this.#stopped) return;
		if (this.#alive && this.#proc) return;

		const { command, args, env, cwd } = this.#config;
		const cmd = [command, ...(args ?? [])];

		this.#proc = Bun.spawn(cmd, {
			stdio: ["ignore", "ignore", "pipe"],
			env: env ? { ...process.env, ...env } : undefined,
			cwd,
		});

		this.#alive = true;
		this.#lastStartedAt = new Date().toISOString();

		// Consume stderr in background
		if (this.#proc.stderr) {
			this.#consumeStderr(this.#proc.stderr as ReadableStream<Uint8Array>);
		}

		// Register postmortem cleanup
		this.#cancelPostmortem?.();
		this.#cancelPostmortem = postmortem.register(`gateway-backend-${this.pid}`, () => {
			this.#killSync();
		});

		// Monitor process exit for auto-restart
		this.#proc.exited
			.then(code => {
				if (this.#stopped) return;
				this.#alive = false;
				logger.warn("[gateway] Managed backend exited", { pid: this.pid, code, cmd: cmd[0] });
				if (this.#autoRestart) {
					this.#scheduleRestart();
				}
			})
			.catch(() => {});

		// Start health check timer
		this.#startHealthChecks();

		logger.debug("[gateway] Managed backend started", { pid: this.#proc.pid, cmd: cmd[0] });
	}

	async stop(): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#alive = false;

		this.#cancelPostmortem?.();
		this.#cancelPostmortem = undefined;

		if (this.#healthTimer) {
			clearInterval(this.#healthTimer);
			this.#healthTimer = undefined;
		}

		if (!this.#proc) return;

		await terminate({ target: this.#proc, timeout: SHUTDOWN_TIMEOUT_MS }).catch(() => {});
		this.#proc = null;
	}

	// -----------------------------------------------------------------------
	// Internal
	// -----------------------------------------------------------------------

	#startHealthChecks(): void {
		if (this.#healthTimer) clearInterval(this.#healthTimer);
		this.#healthFailures = 0;

		this.#healthTimer = setInterval(() => {
			if (!this.#proc || this.#stopped) {
				if (this.#healthTimer) clearInterval(this.#healthTimer);
				return;
			}
			if (!isPidRunning(this.#proc)) {
				this.#healthFailures++;
				if (this.#healthFailures >= MAX_HEALTH_FAILURES) {
					logger.warn("[gateway] Health check failed, marking backend as down", {
						pid: this.pid,
						failures: this.#healthFailures,
					});
					this.#alive = false;
					if (this.#healthTimer) clearInterval(this.#healthTimer);
					this.#healthTimer = undefined;
					if (this.#autoRestart && !this.#stopped) {
						this.#scheduleRestart();
					}
				}
			} else {
				this.#healthFailures = 0;
			}
		}, HEALTH_CHECK_INTERVAL_MS);

		// Don't keep the process alive just for health checks
		if (this.#healthTimer && "unref" in this.#healthTimer) {
			(this.#healthTimer as NodeJS.Timeout).unref();
		}
	}

	#scheduleRestart(): void {
		if (this.#stopped) return;
		this.#restarts++;
		const delay = Math.min(this.#backoffMs, MAX_BACKOFF_MS);
		this.#backoffMs = Math.min(this.#backoffMs * 2, MAX_BACKOFF_MS);

		logger.debug("[gateway] Scheduling backend restart", {
			restarts: this.#restarts,
			delayMs: delay,
		});

		setTimeout(() => {
			if (this.#stopped) return;
			this.start().catch(err => {
				logger.error("[gateway] Failed to restart backend", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}, delay);
	}

	#killSync(): void {
		try {
			this.#proc?.kill();
		} catch {
			// Already dead
		}
		this.#alive = false;
	}

	#consumeStderr(stream: ReadableStream<Uint8Array>): void {
		const decoder = new TextDecoder();
		(async () => {
			for await (const chunk of stream) {
				for (const line of decoder.decode(chunk).split("\n")) {
					if (line.trim()) {
						logger.debug(`[gateway:backend:${this.pid}] ${line.trim()}`);
					}
				}
			}
		})().catch(() => {});
	}
}

/**
 * Manages multiple ManagedBackend instances keyed by alias.
 */
export class ProcessManager {
	#backends = new Map<string, ManagedBackend>();

	async spawn(alias: string, config: ManagedProcessConfig): Promise<ManagedBackend> {
		const existing = this.#backends.get(alias);
		if (existing?.alive) return existing;

		// Stop any dead backend before creating new one
		if (existing) {
			await existing.stop();
		}

		const backend = new ManagedBackend(config);
		this.#backends.set(alias, backend);
		await backend.start();
		return backend;
	}

	async stop(alias: string): Promise<void> {
		const backend = this.#backends.get(alias);
		if (!backend) return;
		await backend.stop();
		this.#backends.delete(alias);
	}

	async stopAll(): Promise<void> {
		const stops = [...this.#backends.values()].map(b => b.stop());
		await Promise.allSettled(stops);
		this.#backends.clear();
	}

	get(alias: string): ManagedBackend | undefined {
		return this.#backends.get(alias);
	}

	getState(alias: string): ManagedBackendState | null {
		return this.#backends.get(alias)?.state ?? null;
	}

	listActive(): Array<{ alias: string; state: ManagedBackendState }> {
		const result: Array<{ alias: string; state: ManagedBackendState }> = [];
		for (const [alias, backend] of this.#backends) {
			if (backend.alive) {
				result.push({ alias, state: backend.state });
			}
		}
		return result;
	}
}

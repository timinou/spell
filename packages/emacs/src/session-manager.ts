import { logger } from "@oh-my-pi/pi-utils";
import type { EmacsSession } from "./daemon";
import type { EmacsWarmupResult } from "./tool";

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60_000;

export interface EmacsSessionManagerOptions {
	startSession: () => Promise<EmacsWarmupResult>;
	failureThreshold?: number;
	cooldownMs?: number;
}

export class EmacsSessionManager {
	readonly #startSession: () => Promise<EmacsWarmupResult>;
	readonly #failureThreshold: number;
	readonly #cooldownMs: number;

	#session: EmacsSession | null = null;
	#pendingStart: Promise<EmacsSession | null> | null = null;
	#consecutiveFailures = 0;
	#cooldownUntil = 0;
	#permanentlyUnavailable = false;
	#disposed = false;

	constructor(options: EmacsSessionManagerOptions) {
		this.#startSession = options.startSession;
		this.#failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
		this.#cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
	}

	async getSession(): Promise<EmacsSession | null> {
		if (this.#disposed) return null;

		const liveSession = this.#getLiveSession();
		if (liveSession) return liveSession;
		if (this.#permanentlyUnavailable) return null;
		if (Date.now() < this.#cooldownUntil) return null;
		if (this.#pendingStart) return this.#pendingStart;

		const pendingStart = this.#startOrRecover().finally(() => {
			if (this.#pendingStart === pendingStart) {
				this.#pendingStart = null;
			}
		});
		this.#pendingStart = pendingStart;
		return pendingStart;
	}

	setSession(session: EmacsSession | null): void {
		if (this.#disposed) {
			if (session?.isAlive()) {
				void this.#stopSession(session, "discard injected session after dispose");
			}
			return;
		}

		if (session?.isAlive()) {
			this.#session = session;
			this.#resetBreaker();
			return;
		}

		this.#session = null;
	}

	recordWarmupResult(result: EmacsWarmupResult | undefined): void {
		if (!result) return;
		const session = this.#applyWarmupResult(result);
		if (this.#disposed && session) {
			void this.#stopSession(session, "dispose after externally warmed session");
		}
	}

	async dispose(): Promise<void> {
		this.#disposed = true;
		this.#pendingStart = null;
		const session = this.#session;
		this.#session = null;
		if (!session?.isAlive()) return;
		await this.#stopSession(session, "dispose active session");
	}

	#getLiveSession(): EmacsSession | null {
		const session = this.#session;
		if (!session) return null;
		if (session.isAlive()) return session;
		this.#session = null;
		return null;
	}

	#resetBreaker(): void {
		this.#consecutiveFailures = 0;
		this.#cooldownUntil = 0;
		this.#permanentlyUnavailable = false;
	}

	#recordFailure(reason: string): void {
		this.#consecutiveFailures += 1;
		if (this.#consecutiveFailures < this.#failureThreshold) return;

		this.#consecutiveFailures = 0;
		this.#cooldownUntil = Date.now() + this.#cooldownMs;
		logger.warn("[emacs-session-manager] startup circuit breaker opened", {
			reason,
			cooldownMs: this.#cooldownMs,
		});
	}

	#markUnavailable(reason: string | undefined): void {
		this.#session = null;
		this.#consecutiveFailures = 0;
		this.#cooldownUntil = 0;
		this.#permanentlyUnavailable = true;
		logger.debug("[emacs-session-manager] Emacs marked permanently unavailable", { reason });
	}

	#applyWarmupResult(result: EmacsWarmupResult): EmacsSession | null {
		switch (result.status) {
			case "ready":
				if (result.session?.isAlive()) {
					this.setSession(result.session);
					return result.session;
				}
				this.#session = null;
				this.#recordFailure(result.error ?? "Warmup returned ready without a live session");
				return null;
			case "error":
				this.#session = null;
				this.#recordFailure(result.error ?? "Emacs startup failed");
				return null;
			case "unavailable":
				this.#markUnavailable(result.error);
				return null;
		}
	}

	async #startOrRecover(): Promise<EmacsSession | null> {
		try {
			const result = await this.#startSession();
			const session = this.#applyWarmupResult(result);
			if (!session || !this.#disposed) return session;
			await this.#stopSession(session, "dispose after startup");
			this.#session = null;
			return null;
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			this.#session = null;
			this.#recordFailure(error);
			logger.warn("[emacs-session-manager] startup attempt failed", { error });
			return null;
		}
	}

	async #stopSession(session: EmacsSession, context: string): Promise<void> {
		try {
			await session.stop();
		} catch (err) {
			logger.warn("[emacs-session-manager] failed to stop session", {
				context,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

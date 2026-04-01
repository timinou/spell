import type { RateLimitConfig } from "./types.ts";

interface DomainState {
  /** Available tokens (fractional). Maximum = burst capacity (= requestsPerMinute). */
  tokens: number;
  /** Monotonic timestamp of last refill, ms. */
  lastRefill: number;
  /** Current backoff delay in ms (0 = no backoff). */
  backoffMs: number;
  /** Resolve callbacks waiting for a token, in FIFO order. */
  queue: Array<() => void>;
}

const DEFAULT_BACKOFF_MULTIPLIER = 2;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
const REFILL_INTERVAL_MS = 100; // granularity of background refill tick

/**
 * Per-domain token-bucket rate limiter with exponential backoff.
 *
 * Token refill rate: `requestsPerMinute / 60` tokens per second.
 * Burst capacity equals one full minute's worth of tokens (= `requestsPerMinute`).
 *
 * `acquire(domain)` blocks until a token is available for that domain.
 * Waiters are served FIFO — no starvation under normal operation.
 *
 * `reportError(domain)` doubles the per-domain backoff (capped at `maxBackoffMs`).
 * The backoff is added on top of token-bucket waiting — callers should call it
 * once per failed request, not once per retry attempt.
 *
 * `dispose()` must be called to stop the background refill interval.
 */
export class RateLimiter {
  readonly #requestsPerMinute: number;
  readonly #backoffMultiplier: number;
  readonly #maxBackoffMs: number;
  /** Refill rate in tokens per millisecond. */
  readonly #refillPerMs: number;
  readonly #domains = new Map<string, DomainState>();
  readonly #intervalHandle: ReturnType<typeof setInterval>;

  constructor(config: RateLimitConfig) {
    this.#requestsPerMinute = config.requestsPerMinute;
    this.#backoffMultiplier = config.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
    this.#maxBackoffMs = config.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    // tokens per ms = (requests/min) / 60_000 ms
    this.#refillPerMs = config.requestsPerMinute / 60_000;

    // Background tick: refill all active domains so waiters can be resolved
    // without requiring a new acquire() call to trigger refill.
    this.#intervalHandle = setInterval(() => {
      this.#tickAll();
    }, REFILL_INTERVAL_MS);
  }

  /**
   * Wait until a request token is available for `domain`, then consume it.
   * Additionally waits out any active backoff before granting the token.
   */
  async acquire(domain: string): Promise<void> {
    const state = this.#getOrCreate(domain);

    // Drain backoff first, independent of the token bucket.
    if (state.backoffMs > 0) {
      const wait = state.backoffMs;
      state.backoffMs = 0; // consume backoff — next call gets no extra wait
      await Bun.sleep(wait);
    }

    this.#refill(state);

    if (state.tokens >= 1) {
      state.tokens -= 1;
      return;
    }

    // No token available — enqueue and wait.
    const { promise, resolve } = Promise.withResolvers<void>();
    state.queue.push(resolve);
    await promise;
  }

  /**
   * Report a request failure for `domain`. Doubles the current backoff
   * (starting from one refill interval) up to `maxBackoffMs`.
   */
  reportError(domain: string): void {
    const state = this.#getOrCreate(domain);
    if (state.backoffMs === 0) {
      state.backoffMs = REFILL_INTERVAL_MS;
    } else {
      state.backoffMs = Math.min(
        state.backoffMs * this.#backoffMultiplier,
        this.#maxBackoffMs,
      );
    }
  }

  /** Stop the background refill interval. Must be called when the limiter is no longer needed. */
  dispose(): void {
    clearInterval(this.#intervalHandle);
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  #getOrCreate(domain: string): DomainState {
    let state = this.#domains.get(domain);
    if (state === undefined) {
      state = {
        tokens: this.#requestsPerMinute, // start fully charged
        lastRefill: Date.now(),
        backoffMs: 0,
        queue: [],
      };
      this.#domains.set(domain, state);
    }
    return state;
  }

  /** Refill tokens based on elapsed time since last refill. */
  #refill(state: DomainState): void {
    const now = Date.now();
    const elapsed = now - state.lastRefill;
    state.lastRefill = now;
    state.tokens = Math.min(
      state.tokens + elapsed * this.#refillPerMs,
      this.#requestsPerMinute, // cap at burst capacity
    );
  }

  /** Refill all domains and drain as many queue waiters as tokens allow. */
  #tickAll(): void {
    for (const state of this.#domains.values()) {
      this.#refill(state);
      while (state.tokens >= 1 && state.queue.length > 0) {
        state.tokens -= 1;
        // biome-ignore lint/style/noNonNullAssertion: length check above guarantees non-null
        state.queue.shift()!();
      }
    }
  }
}

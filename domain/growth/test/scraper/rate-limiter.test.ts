import { describe, test, expect, afterEach } from "bun:test";
import { RateLimiter } from "../../src/scraper/rate-limiter.ts";

// Timing notes:
//   REFILL_INTERVAL_MS inside rate-limiter is 100 ms.
//   We pick requestsPerMinute = 600 → refillPerMs = 0.01 → 1 token per 100ms tick.
//   This lets us drain 600 tokens immediately (all have tokens) and then the next
//   acquire blocks for roughly one tick (≈100ms).

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  afterEach(() => {
    // Always dispose so setInterval doesn't leak across tests.
    limiter?.dispose();
  });

  test("acquire() resolves immediately when tokens are available", async () => {
    limiter = new RateLimiter({ requestsPerMinute: 60 });
    const start = Date.now();
    await limiter.acquire("example.com");
    expect(Date.now() - start).toBeLessThan(50);
  });

  test("acquire() waits when bucket is empty", async () => {
    // 600 RPM: burst = 600 tokens, refill = 1 token per 100ms tick.
    limiter = new RateLimiter({ requestsPerMinute: 600 });

    // Drain all 600 tokens synchronously (each acquire has a token available,
    // so they resolve through the microtask queue without touching setInterval).
    for (let i = 0; i < 600; i++) {
      await limiter.acquire("example.com");
    }

    // Next acquire must wait for at least one refill tick.
    const start = Date.now();
    await limiter.acquire("example.com");
    const elapsed = Date.now() - start;

    // Should have waited at least one tick (~100ms); well under a full second.
    expect(elapsed).toBeGreaterThan(50);
    expect(elapsed).toBeLessThan(600);
  }, 5000);

  test("per-domain isolation: separate buckets per domain", async () => {
    limiter = new RateLimiter({ requestsPerMinute: 600 });

    // Drain domain A entirely.
    for (let i = 0; i < 600; i++) {
      await limiter.acquire("a.com");
    }

    // Domain B is untouched — its first acquire should be immediate.
    const start = Date.now();
    await limiter.acquire("b.com");
    expect(Date.now() - start).toBeLessThan(50);
  });

  test("reportError() triggers backoff on next acquire", async () => {
    // High RPM so the token bucket never blocks on its own.
    limiter = new RateLimiter({ requestsPerMinute: 60_000 });

    // REFILL_INTERVAL_MS = 100, so first reportError sets backoffMs = 100.
    limiter.reportError("example.com");

    const start = Date.now();
    await limiter.acquire("example.com");
    const elapsed = Date.now() - start;

    // Slept 100ms for the backoff.
    expect(elapsed).toBeGreaterThan(80);
    expect(elapsed).toBeLessThan(400);
  });

  test("reportError() doubles on repeated calls", () => {
    limiter = new RateLimiter({ requestsPerMinute: 60_000 });

    // First call: 0 → REFILL_INTERVAL_MS (100)
    limiter.reportError("example.com");
    // Second call: 100 * 2 = 200
    limiter.reportError("example.com");
    // Third call: 200 * 2 = 400
    limiter.reportError("example.com");

    // We can't read backoffMs directly (private), but we can observe that a
    // subsequent acquire sleeps ≥ 400ms.
    const start = Date.now();
    const p = limiter.acquire("example.com");

    // Verify the promise is still pending after 300ms (the backoff hasn't expired).
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Still pending — correct. Dispose to unblock the promise, then finish.
        limiter.dispose();
        resolve();
      }, 350);

      p.then(() => {
        // If it resolved before 350ms with 400ms backoff, the backoff is wrong.
        const elapsed = Date.now() - start;
        clearTimeout(timeout);
        if (elapsed < 350) {
          reject(
            new Error(
              `Expected backoff ≥400ms but acquire resolved in ${elapsed}ms`,
            ),
          );
        } else {
          resolve();
        }
      }).catch(reject);
    });
  }, 5000);

  test("reportError() caps backoff at maxBackoffMs", () => {
    limiter = new RateLimiter({
      requestsPerMinute: 60_000,
      maxBackoffMs: 200,
      backoffMultiplier: 2,
    });

    // Drive backoff past the cap: 100 → 200 → 200 (capped).
    limiter.reportError("example.com");
    limiter.reportError("example.com");
    limiter.reportError("example.com"); // would be 400 without cap

    // Acquire should sleep exactly 200ms (the cap), not longer.
    const start = Date.now();
    const p = limiter.acquire("example.com");

    return new Promise<void>((resolve, reject) => {
      // After 350ms the acquire should definitely be done (200ms cap + some slack).
      const timeout = setTimeout(() => {
        limiter.dispose();
        reject(new Error("acquire took longer than expected cap"));
      }, 500);

      p.then(() => {
        const elapsed = Date.now() - start;
        clearTimeout(timeout);
        if (elapsed < 150) {
          reject(
            new Error(`Backoff resolved too early: ${elapsed}ms < 150ms cap`),
          );
        } else {
          resolve();
        }
      }).catch(reject);
    });
  }, 3000);

  test("dispose() stops the background interval", async () => {
    limiter = new RateLimiter({ requestsPerMinute: 60 });
    // Calling dispose twice must not throw (clearInterval is idempotent).
    limiter.dispose();
    expect(() => limiter.dispose()).not.toThrow();
  });
});

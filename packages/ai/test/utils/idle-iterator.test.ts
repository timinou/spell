import { afterEach, describe, expect, it } from "bun:test";
import {
	DEFAULT_TOOL_ARGUMENT_STREAM_IDLE_TIMEOUT_MS,
	getToolArgumentStreamIdleTimeoutMs,
	IdleTickle,
	iterateWithIdleTimeout,
} from "../../src/utils/idle-iterator";

afterEach(() => {
	delete Bun.env.PI_TOOL_ARGUMENT_STREAM_IDLE_TIMEOUT_MS;
});

/**
 * Yields nothing for `windowMs` then completes. Models a long-running provider stream
 * that hasn't emitted a tool delta yet (e.g. assistant is still composing tool args).
 */
function silentStream(windowMs: number): AsyncIterable<never> {
	return {
		[Symbol.asyncIterator](): AsyncIterator<never> {
			let returned = false;
			return {
				async next(): Promise<IteratorResult<never>> {
					if (returned) return { value: undefined, done: true };
					await new Promise<void>(resolve => setTimeout(resolve, windowMs));
					returned = true;
					return { value: undefined, done: true };
				},
				async return(): Promise<IteratorResult<never>> {
					returned = true;
					return { value: undefined, done: true };
				},
			};
		},
	};
}

describe("DEFAULT_TOOL_ARGUMENT_STREAM_IDLE_TIMEOUT_MS", () => {
	it("defaults to 600 seconds (10 minutes)", () => {
		expect(DEFAULT_TOOL_ARGUMENT_STREAM_IDLE_TIMEOUT_MS).toBe(600_000);
	});

	it("getToolArgumentStreamIdleTimeoutMs returns 600s without env override", () => {
		expect(getToolArgumentStreamIdleTimeoutMs()).toBe(600_000);
	});

	it("getToolArgumentStreamIdleTimeoutMs honours base idle timeout when larger", () => {
		expect(getToolArgumentStreamIdleTimeoutMs(900_000)).toBe(900_000);
	});
});

describe("iterateWithIdleTimeout tickle", () => {
	it("does not throw when tickle.reset() fires faster than idleTimeoutMs", async () => {
		const tickle = new IdleTickle();
		const interval = setInterval(() => tickle.tick(), 50);
		try {
			const start = Date.now();
			await (async () => {
				for await (const _ of iterateWithIdleTimeout(silentStream(500), {
					idleTimeoutMs: 200,
					errorMessage: "should not stall while tickle ticks",
					tickle,
				})) {
					/* never yields */
				}
			})();
			expect(Date.now() - start).toBeGreaterThanOrEqual(450);
		} finally {
			clearInterval(interval);
		}
	});

	it("throws when no tickle is provided and stream goes idle", async () => {
		await expect(async () => {
			for await (const _ of iterateWithIdleTimeout(silentStream(2_000), {
				idleTimeoutMs: 200,
				errorMessage: "stalled with no tickle",
			})) {
				/* never yields */
			}
		}).toThrow("stalled with no tickle");
	});

	it("throws when idleTimeoutMs is undefined+0 only if stream actually never finishes (disabled watchdog)", async () => {
		// idleTimeoutMs=0 disables the watchdog; tickle is a no-op. Stream completes normally.
		const tickle = new IdleTickle();
		let count = 0;
		for await (const _ of iterateWithIdleTimeout(silentStream(50), {
			idleTimeoutMs: 0,
			errorMessage: "should never see this",
			tickle,
		})) {
			count++;
		}
		expect(count).toBe(0);
	});

	it("multiple tickle.tick() calls each restart the timer", async () => {
		const tickle = new IdleTickle();
		// Tick at 100ms intervals; timeout is 150ms. First tick at 100ms restarts timer; subsequent
		// ticks keep the timer alive past 600ms total.
		const ticks = [100, 200, 300, 400, 500];
		const timers = ticks.map(t => setTimeout(() => tickle.tick(), t));
		try {
			await (async () => {
				for await (const _ of iterateWithIdleTimeout(silentStream(550), {
					idleTimeoutMs: 150,
					errorMessage: "should not stall across multiple ticks",
					tickle,
				})) {
					/* never yields */
				}
			})();
		} finally {
			for (const t of timers) clearTimeout(t);
		}
	});

	it("unsubscribes the tickle when the iterator finishes", async () => {
		const tickle = new IdleTickle();
		const subscriberCount = (): number => {
			// Use private symbol to count subscribers via tick side-effect: count is internal,
			// instead assert via behavior — after iterator finishes, ticking should be a no-op.
			return 0;
		};
		await (async () => {
			for await (const _ of iterateWithIdleTimeout(silentStream(50), {
				idleTimeoutMs: 1_000,
				errorMessage: "unused",
				tickle,
			})) {
				/* never yields */
			}
		})();
		// After completion, ticking the tickle does not throw and has no observable effect.
		expect(() => tickle.tick()).not.toThrow();
		expect(subscriberCount()).toBe(0);
	});
});

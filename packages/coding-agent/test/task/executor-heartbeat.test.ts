import { describe, expect, it } from "bun:test";
import { createProgressHeartbeat } from "../../src/task/progress-heartbeat";

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe("createProgressHeartbeat", () => {
	it("fires the tick callback at the configured interval while active", async () => {
		let ticks = 0;
		const heartbeat = createProgressHeartbeat({
			intervalMs: 20,
			isActive: () => true,
			tick: () => {
				ticks++;
			},
		});

		// Three intervals worth of slack — Bun's setInterval drift is bounded.
		await wait(80);
		heartbeat.stop();

		expect(ticks).toBeGreaterThanOrEqual(2);
	});

	it("skips ticks while isActive() returns false", async () => {
		let ticks = 0;
		let active = false;
		const heartbeat = createProgressHeartbeat({
			intervalMs: 15,
			isActive: () => active,
			tick: () => {
				ticks++;
			},
		});

		await wait(60);
		expect(ticks).toBe(0);

		active = true;
		await wait(60);
		heartbeat.stop();

		expect(ticks).toBeGreaterThanOrEqual(2);
	});

	it("stops firing once stop() has been called", async () => {
		let ticks = 0;
		const heartbeat = createProgressHeartbeat({
			intervalMs: 15,
			isActive: () => true,
			tick: () => {
				ticks++;
			},
		});

		await wait(50);
		heartbeat.stop();
		const ticksAtStop = ticks;
		await wait(60);

		expect(ticks).toBe(ticksAtStop);
	});

	it("does not keep the event loop alive on its own", () => {
		const heartbeat = createProgressHeartbeat({
			intervalMs: 1_000,
			isActive: () => true,
			tick: () => {},
		});

		// Bun timers expose hasRef() — assert the heartbeat unrefs its timer so a
		// runaway subprocess can't prevent process exit.
		const internal = heartbeat as unknown as { _timer?: { hasRef?: () => boolean } };
		if (internal._timer?.hasRef) {
			expect(internal._timer.hasRef()).toBe(false);
		}
		heartbeat.stop();
	});
});

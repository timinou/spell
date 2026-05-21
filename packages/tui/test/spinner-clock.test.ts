import { afterEach, describe, expect, it } from "bun:test";
import { spinnerClock } from "../src/spinner-clock";

describe("SpinnerClock", () => {
	afterEach(() => {
		spinnerClock.resetForTest();
	});

	it("calls all subscribers on each tick", async () => {
		const calls = [0, 0, 0];
		const unsubs = [
			spinnerClock.subscribe(() => calls[0]++),
			spinnerClock.subscribe(() => calls[1]++),
			spinnerClock.subscribe(() => calls[2]++),
		];
		await Bun.sleep(85);
		expect(calls[0]).toBeGreaterThanOrEqual(1);
		expect(calls[1]).toBe(calls[0]);
		expect(calls[2]).toBe(calls[0]);
		for (const u of unsubs) u();
	});

	it("stops the underlying interval when subscribers reach 0", async () => {
		const unsub = spinnerClock.subscribe(() => {});
		expect(spinnerClock.tickCount).toBeGreaterThanOrEqual(0);
		unsub();
		const tickBefore = spinnerClock.tickCount;
		await Bun.sleep(120);
		expect(spinnerClock.tickCount).toBe(tickBefore); // no further ticks
	});

	it("is safe under subscriber-removing-itself", async () => {
		let calls = 0;
		const unsub = spinnerClock.subscribe(() => {
			calls++;
			unsub();
		});
		await Bun.sleep(85);
		expect(calls).toBe(1);
		await Bun.sleep(85);
		expect(calls).toBe(1); // unsubscribed after first tick
	});

	it("frame advances with tickCount", async () => {
		const unsub = spinnerClock.subscribe(() => {});
		await Bun.sleep(85);
		expect(spinnerClock.frame).toBeGreaterThanOrEqual(0);
		expect(spinnerClock.frame).toBe(spinnerClock.tickCount);
		unsub();
	});
});

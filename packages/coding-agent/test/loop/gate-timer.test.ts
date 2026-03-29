import { describe, expect, it } from "bun:test";
import { GateTimer } from "../../src/loop/gates/timer";
import { VirtualClock } from "../helpers/virtual-clock";

describe("GateTimer", () => {
	it("fires, cancels, and resets using the virtual clock", () => {
		const clock = new VirtualClock();
		let fired = 0;
		const timer = new GateTimer(clock, 100, () => {
			fired += 1;
		});
		timer.start();
		clock.advance(99);
		expect(fired).toBe(0);
		clock.advance(1);
		expect(fired).toBe(1);

		timer.start();
		timer.cancel();
		clock.advance(100);
		expect(fired).toBe(1);

		timer.reset(50);
		clock.advance(49);
		expect(fired).toBe(1);
		clock.advance(1);
		expect(fired).toBe(2);
	});
});

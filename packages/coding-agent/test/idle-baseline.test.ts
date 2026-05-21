import { describe, expect, it, vi } from "bun:test";

describe("Adaptive idle baseline — heartbeat debounce", () => {
	it("fires heartbeat only after N seconds of silence", () => {
		vi.useFakeTimers();

		let heartbeatCount = 0;
		let timer: NodeJS.Timeout | undefined;

		const sendHeartbeat = () => {
			heartbeatCount++;
		};

		const resetSilence = () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				sendHeartbeat();
				resetSilence(); // re-arm
			}, 5_000);
			timer.unref?.();
		};

		resetSilence(); // arm initially

		// Quiet for 3s — no heartbeat.
		vi.advanceTimersByTime(3_000);
		expect(heartbeatCount).toBe(0);

		// Activity at t=3s resets timer.
		resetSilence();
		vi.advanceTimersByTime(4_000);
		expect(heartbeatCount).toBe(0);

		// First heartbeat at t=8s (5s after last reset).
		vi.advanceTimersByTime(1_000);
		expect(heartbeatCount).toBe(1);

		// Next heartbeat auto-arms; fires at t=13s.
		vi.advanceTimersByTime(5_000);
		expect(heartbeatCount).toBe(2);

		// Activity at t=13s resets timer again.
		resetSilence();
		vi.advanceTimersByTime(4_999);
		expect(heartbeatCount).toBe(2);
		vi.advanceTimersByTime(1);
		expect(heartbeatCount).toBe(3);

		if (timer) clearTimeout(timer);
		vi.useRealTimers();
	});

	it("does not fire after disposal", () => {
		vi.useFakeTimers();

		let heartbeatCount = 0;
		let timer: NodeJS.Timeout | undefined;

		const resetSilence = () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				heartbeatCount++;
				resetSilence();
			}, 5_000);
		};

		resetSilence();
		vi.advanceTimersByTime(2_000);

		// Dispose
		if (timer) clearTimeout(timer);
		vi.advanceTimersByTime(60_000);
		expect(heartbeatCount).toBe(0);

		vi.useRealTimers();
	});
});

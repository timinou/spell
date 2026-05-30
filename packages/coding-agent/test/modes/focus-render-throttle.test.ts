/**
 * Tests for FocusRenderThrottle — BUG-421.
 *
 * The throttle combines (focused, streaming) into a derived render interval:
 *
 *   focused                  → focusedInterval
 *   !focused && streaming    → focusedInterval   (fix for BUG-421)
 *   !focused && !streaming   → unfocusedInterval
 *
 * Without the fix, a focus-out during a stream pegs the render rate at
 * 500ms and the operator sees the chat "freeze then catch up at end."
 * With it, a stream restores the focused interval as long as it lasts;
 * idle CPU savings (FEAT-358) resume the instant the stream ends.
 *
 * The class is pure: no terminal, no agent, no timers. Tests assert the
 * exact sequence of `applyInterval()` calls — no spurious applies, no
 * missing ones.
 */
import { describe, expect, it } from "bun:test";
import { FocusRenderThrottle } from "@spell/pi-coding-agent/modes/focus-render-throttle";

interface Probe {
	throttle: FocusRenderThrottle;
	applied: number[];
}

function makeThrottle(focusedInterval = 16, unfocusedInterval = 500): Probe {
	const applied: number[] = [];
	const throttle = new FocusRenderThrottle({
		focusedInterval,
		unfocusedInterval,
		applyInterval: ms => applied.push(ms),
	});
	return { throttle, applied };
}

describe("FocusRenderThrottle (BUG-421)", () => {
	it("starts focused + idle with no apply — defers to caller's initial setting", () => {
		const { applied, throttle } = makeThrottle();
		expect(applied).toEqual([]);
		expect(throttle.currentInterval).toBe(16);
	});

	it("applies unfocusedInterval on focus-out while idle", () => {
		const { applied, throttle } = makeThrottle();
		throttle.setFocused(false);
		expect(applied).toEqual([500]);
	});

	it("restores focusedInterval on focus-in while idle", () => {
		const { applied, throttle } = makeThrottle();
		throttle.setFocused(false);
		throttle.setFocused(true);
		expect(applied).toEqual([500, 16]);
	});

	it("FIX: stream-start while unfocused restores focusedInterval", () => {
		const { applied, throttle } = makeThrottle();
		throttle.setFocused(false);
		expect(applied).toEqual([500]);
		throttle.setStreaming(true);
		// During an active stream, responsiveness wins over CPU savings even
		// when the terminal is reportedly unfocused — focus-out is often a
		// stale signal (compositor edge case, multiplexer dropped focus-in).
		expect(applied).toEqual([500, 16]);
	});

	it("FIX: stream-end while still unfocused returns to unfocusedInterval", () => {
		const { applied, throttle } = makeThrottle();
		throttle.setFocused(false);
		throttle.setStreaming(true);
		expect(applied).toEqual([500, 16]);
		throttle.setStreaming(false);
		// Stream ended. Terminal is still reportedly unfocused → resume
		// idle-mode throttle. Idle CPU/battery savings (FEAT-358) intact.
		expect(applied).toEqual([500, 16, 500]);
	});

	it("stream-start while focused is a no-op (already at focusedInterval)", () => {
		const { applied, throttle } = makeThrottle();
		throttle.setStreaming(true);
		// Focused + streaming → still focusedInterval. Same as focused + idle.
		// No new apply.
		expect(applied).toEqual([]);
	});

	it("focus-in while streaming is a no-op (already at focusedInterval)", () => {
		const { applied, throttle } = makeThrottle();
		throttle.setFocused(false);
		throttle.setStreaming(true);
		expect(applied).toEqual([500, 16]);
		throttle.setFocused(true);
		// !focused→focused while streaming: both states now want focused
		// interval. Already applied. Dedupe — no spurious extra apply.
		expect(applied).toEqual([500, 16]);
	});

	it("focus-out while streaming is a no-op (streaming pins focusedInterval)", () => {
		const { applied, throttle } = makeThrottle();
		throttle.setStreaming(true);
		throttle.setFocused(false);
		// focused→!focused while streaming: streaming still wins; stays at
		// focusedInterval. No apply.
		expect(applied).toEqual([]);
	});

	it("ignores idempotent setter calls", () => {
		const { applied, throttle } = makeThrottle();
		throttle.setFocused(true); // already true
		throttle.setStreaming(false); // already false
		throttle.setFocused(false);
		throttle.setFocused(false); // duplicate
		throttle.setStreaming(true);
		throttle.setStreaming(true); // duplicate
		// Only the two real transitions count:
		//   focused:true→false (idle)  → apply 500
		//   streaming:false→true        → apply 16
		expect(applied).toEqual([500, 16]);
	});

	it("clamps unfocusedInterval below focusedInterval up to focusedInterval", () => {
		const { applied, throttle } = makeThrottle(50, 16);
		// Caller passed a smaller unfocused; the clamp keeps unfocused ≥ focused
		// — here they're equal at 50. Focus-out has no effective change to apply
		// (focused and unfocused both want 50), so the throttle correctly stays
		// silent. The clamp is observable through the desired-state derivation,
		// not through an apply() call at this edge.
		throttle.setFocused(false);
		expect(applied).toEqual([]);
		expect(throttle.currentInterval).toBe(50);
	});

	it("full lifecycle: idle → stream → idle, all while unfocused, applies exactly twice", () => {
		const { applied, throttle } = makeThrottle();
		throttle.setFocused(false); // -> 500
		throttle.setStreaming(true); // -> 16  (FIX)
		throttle.setStreaming(false); // -> 500
		throttle.setStreaming(true); // -> 16
		throttle.setStreaming(false); // -> 500
		expect(applied).toEqual([500, 16, 500, 16, 500]);
	});

	it("multiple focus toggles during a single stream stay at focusedInterval", () => {
		const { applied, throttle } = makeThrottle();
		throttle.setStreaming(true);
		throttle.setFocused(false);
		throttle.setFocused(true);
		throttle.setFocused(false);
		throttle.setFocused(true);
		// All deduped; the entire stream window stayed at focusedInterval.
		expect(applied).toEqual([]);
	});
});

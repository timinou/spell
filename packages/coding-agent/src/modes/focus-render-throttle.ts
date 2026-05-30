/**
 * Focus-aware render throttle — BUG-421.
 *
 * When the terminal window loses focus (niri overview, workspace switch,
 * compositor minimisation, multiplexer pane switch), CSI 1004h focus-out
 * fires and we previously dropped `setMinRenderInterval(500)` unconditionally.
 * That is fine when the session is idle (saves CPU/battery), but during an
 * active agent stream it caps repaints at ~2fps — a 2-second tool-heavy turn
 * emits ~200 events and only ~4 paints fire, all clustered near `message_end`.
 * The operator perception is "TUI freezes mid-stream then catches up at the
 * end" (BUG-421 §Symptom).
 *
 * The fix is to combine two boolean signals — terminal `focused` and agent
 * `streaming` — into a single derived throttle:
 *
 *   focused                 → focusedInterval
 *   !focused && streaming   → focusedInterval   (responsiveness wins)
 *   !focused && !streaming  → unfocusedInterval (idle CPU/battery wins)
 *
 * This module is the pure decision logic. It exposes `setFocused()` /
 * `setStreaming()` setters; the caller wires them to the terminal's
 * `onFocusChange` and the agent session's `subscribe()` (filtering for
 * `agent_start` / `agent_end` events). Keeping this class I/O-free makes it
 * unit-testable without spinning up a real terminal or agent.
 *
 * Idle CPU savings (FEAT-358) remain intact: as soon as a stream ends and
 * the terminal is still unfocused, the unfocused interval is restored.
 */

export interface FocusRenderThrottleOptions {
	/**
	 * Render interval when focused (and when streaming, regardless of focus).
	 * Typically 16ms.
	 */
	focusedInterval: number;
	/**
	 * Render interval when unfocused AND not streaming. Typically 500ms.
	 * Will be clamped to `>= focusedInterval` by the caller.
	 */
	unfocusedInterval: number;
	/**
	 * Sink that applies the chosen interval to the actual render scheduler.
	 * Called once per state change that produces a new interval; not called
	 * on no-op transitions (idempotent at the boundary).
	 */
	applyInterval: (ms: number) => void;
}

/**
 * Pure derived-throttle state machine. No I/O; testable with a spy
 * `applyInterval`. The caller owns subscription lifetime: dispose unsubs.
 */
export class FocusRenderThrottle {
	#focused = true;
	#streaming = false;
	#focusedInterval: number;
	#unfocusedInterval: number;
	#applyInterval: (ms: number) => void;
	#lastApplied: number;

	constructor(options: FocusRenderThrottleOptions) {
		this.#focusedInterval = options.focusedInterval;
		this.#unfocusedInterval = Math.max(options.focusedInterval, options.unfocusedInterval);
		this.#applyInterval = options.applyInterval;
		// Initial state: focused + idle → focusedInterval. Do NOT apply on
		// construction — the caller already created the underlying TUI with
		// its own default, and re-applying would just be noise. We record
		// the last-applied value so subsequent transitions can dedupe.
		this.#lastApplied = this.#focusedInterval;
	}

	setFocused(focused: boolean): void {
		if (this.#focused === focused) return;
		this.#focused = focused;
		this.#reconcile();
	}

	setStreaming(streaming: boolean): void {
		if (this.#streaming === streaming) return;
		this.#streaming = streaming;
		this.#reconcile();
	}

	/** Compute desired interval from current state and apply if it changed. */
	#reconcile(): void {
		const desired = this.#focused || this.#streaming ? this.#focusedInterval : this.#unfocusedInterval;
		if (desired === this.#lastApplied) return;
		this.#lastApplied = desired;
		this.#applyInterval(desired);
	}

	/** Test-only inspection of the most recently applied interval. */
	get currentInterval(): number {
		return this.#lastApplied;
	}
}

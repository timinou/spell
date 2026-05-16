/**
 * Periodic tick used by {@link runSubprocess} so a subagent that goes
 * silent (long-running tool call, idle wait, etc.) still produces visible
 * progress updates on the parent. Without this, `scheduleProgress` only
 * fires from inbound `AgentEvent` handlers, so the parent's task block can
 * freeze for the entire duration of a single quiet tool call.
 *
 * Kept standalone (no other dependencies) so it can be unit-tested without
 * pulling in the executor's transitive imports.
 */
export interface ProgressHeartbeatOptions {
	/** How often to invoke `tick` (ms). */
	intervalMs: number;
	/** Whether the heartbeat should currently emit. Re-evaluated every interval. */
	isActive: () => boolean;
	/** Callback invoked on each active tick. Must be cheap (coalesce downstream). */
	tick: () => void;
}

export interface ProgressHeartbeat {
	/** Cancel the underlying timer. Safe to call multiple times. */
	stop(): void;
}

export function createProgressHeartbeat(opts: ProgressHeartbeatOptions): ProgressHeartbeat {
	const timer = setInterval(() => {
		if (!opts.isActive()) return;
		try {
			opts.tick();
		} catch {
			// Heartbeat must never throw out of the timer — a broken tick must
			// not kill the subprocess driver. Failures are silently absorbed;
			// real progress flow continues through `scheduleProgress`.
		}
	}, opts.intervalMs);

	if (typeof timer === "object" && timer && "unref" in timer && typeof timer.unref === "function") {
		timer.unref();
	}

	let stopped = false;
	return {
		stop() {
			if (stopped) return;
			stopped = true;
			clearInterval(timer);
		},
		// Expose the underlying timer for hasRef() introspection in tests only.
		// Not part of the public contract; consumers should ignore.
		// @ts-expect-error: test-only escape hatch
		_timer: timer,
	};
}

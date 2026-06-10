/**
 * FEAT-784 — push-subscribe path in MemoryStatusController.
 *
 * Three things to prove:
 *   1. Push event from the daemon triggers an immediate poll (no need to
 *      wait for the scheduled interval).
 *   2. Subscribe failure (daemon unreachable / refused) falls back to
 *      polling silently — no throw, no widget noise.
 *   3. Dispose unsubscribes; no leaked subscription.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { KnowledgeEvent } from "@spell/pi-natives";
import { MemoryStatusController } from "../../../src/modes/controllers/memory-status-controller";
import type { MemoryProgressSnapshot } from "../../../src/tools/memory";
import type { InteractiveModeContext } from "../../../src/modes/types";

type StatusEvent = { key: string; text: string | undefined };

interface FakeCtx {
	ctx: InteractiveModeContext;
	statusEvents: StatusEvent[];
}

function makeCtx(cwd = "/tmp/fake-cwd"): FakeCtx {
	const statusEvents: StatusEvent[] = [];
	const ctx = {
		sessionManager: { getCwd: () => cwd },
		statusLine: {
			setHookStatus: (key: string, text: string | undefined) => {
				statusEvents.push({ key, text });
			},
		},
		ui: { requestRender: () => {} },
	} as unknown as InteractiveModeContext;
	return { ctx, statusEvents };
}

function snap(status: MemoryProgressSnapshot["status"]): MemoryProgressSnapshot {
	return { status };
}

let intervalCallbacks: Array<() => void> = [];
let intervalIds: number[] = [];

const fakeSetInterval = ((cb: () => void) => {
	intervalCallbacks.push(cb);
	const id = (intervalIds.length + 1) as unknown as ReturnType<typeof setInterval>;
	intervalIds.push(id as unknown as number);
	return id;
}) as unknown as typeof setInterval;
const fakeClearInterval = (() => {}) as unknown as typeof clearInterval;

/** Yield ~4 microtask turns so fire-and-forget Promise chains settle. */
async function flushPolls(): Promise<void> {
	for (let i = 0; i < 4; i++) await Promise.resolve();
}

beforeEach(() => {
	intervalCallbacks = [];
	intervalIds = [];
});
afterEach(() => {
	intervalCallbacks = [];
	intervalIds = [];
});

describe("MemoryStatusController FEAT-784 push-subscribe", () => {
	it("a push event triggers an immediate poll without waiting for the interval", async () => {
		const { ctx, statusEvents } = makeCtx();
		// First peek call returns warming, subsequent returns warm. The
		// push event fires between, so we should see *both* states in
		// statusEvents — proving the push triggered an extra poll.
		const peekStates: MemoryProgressSnapshot[] = [
			snap("warming"),
			snap("warm"),
			snap("warm"),
		];
		let peekIdx = 0;
		const peek = async () => peekStates[Math.min(peekIdx++, peekStates.length - 1)]!;

		let capturedHandler: ((event: KnowledgeEvent) => void) | undefined;
		let unsubscribeCalls = 0;
		const subscribe = (
			_handle: string,
			_lanes: string[],
			onEvent: (event: KnowledgeEvent) => void,
		) => {
			capturedHandler = onEvent;
			return {
				unsubscribe: () => {
					unsubscribeCalls += 1;
				},
				error: null,
			};
		};

		const controller = new MemoryStatusController(ctx, {
			peek,
			subscribe,
			setIntervalFn: fakeSetInterval,
			clearIntervalFn: fakeClearInterval,
		});
		controller.start();
		await flushPolls();

		// First poll fired → warming text emitted.
		expect(statusEvents.length).toBeGreaterThan(0);
		expect(statusEvents[0]!.text).toContain("indexing");
		expect(capturedHandler).toBeDefined();

		// Daemon pushes warm_completed.
		capturedHandler!({ event: "warm_completed" });
		await flushPolls();

		// Poll re-fired; the warming→warm transition flashes a transient
		// "memory ready" confirmation (cleared later by the flash timer).
		expect(statusEvents.length).toBe(2);
		expect(statusEvents[1]!.text).toContain("memory ready");

		controller.dispose();
		expect(unsubscribeCalls).toBe(1);
	});

	it("subscribe failure falls back silently to polling-only", async () => {
		const { ctx, statusEvents } = makeCtx();
		const peek = async () => snap("warming");
		let subscribeCalled = false;

		const controller = new MemoryStatusController(ctx, {
			peek,
			subscribe: () => {
				subscribeCalled = true;
				return {
					unsubscribe: () => {},
					error: new Error("knowledge subscribe failed: connect ENOENT"),
				};
			},
			setIntervalFn: fakeSetInterval,
			clearIntervalFn: fakeClearInterval,
		});

		// Must not throw despite subscribe error.
		expect(() => controller.start()).not.toThrow();
		await flushPolls();

		// Subscribe was attempted (real attempt), but its failure didn't
		// stop the polling-driven first frame.
		expect(subscribeCalled).toBe(true);
		expect(statusEvents.length).toBeGreaterThan(0);
		expect(statusEvents[0]!.text).toContain("indexing");

		controller.dispose();
	});

	it("dispose unsubscribes only once, even if called twice", () => {
		const { ctx } = makeCtx();
		let unsubscribeCalls = 0;
		const controller = new MemoryStatusController(ctx, {
			peek: async () => snap("warm"),
			subscribe: () => ({
				unsubscribe: () => {
					unsubscribeCalls += 1;
				},
				error: null,
			}),
			setIntervalFn: fakeSetInterval,
			clearIntervalFn: fakeClearInterval,
		});
		controller.start();
		controller.dispose();
		controller.dispose();
		expect(unsubscribeCalls).toBe(1);
	});
});

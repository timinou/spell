import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MemoryStatusController } from "../../../src/modes/controllers/memory-status-controller";
import type { MemoryProgressSnapshot } from "../../../src/tools/memory";
import type { InteractiveModeContext } from "../../../src/modes/types";

interface StatusEvent {
	key: string;
	text: string | undefined;
}

function makeCtx(cwd = "/tmp/repo"): {
	ctx: InteractiveModeContext;
	statusEvents: StatusEvent[];
	renderCount: () => number;
} {
	const statusEvents: StatusEvent[] = [];
	let renders = 0;
	const ctx = {
		sessionManager: {
			getCwd: () => cwd,
		},
		statusLine: {
			setHookStatus: (key: string, text: string | undefined) => {
				statusEvents.push({ key, text });
			},
		},
		ui: {
			requestRender: () => {
				renders++;
			},
		},
	} as unknown as InteractiveModeContext;
	return { ctx, statusEvents, renderCount: () => renders };
}

function snap(
	status: MemoryProgressSnapshot["status"],
	progress?: MemoryProgressSnapshot["progress"],
): MemoryProgressSnapshot {
	return progress ? { status, progress } : { status };
}

/**
 * FEAT-780: `poll()` is async now (peek is async). Tests that drive
 * polls synchronously via `intervalCallbacks[0]?.()` must yield to the
 * microtask queue between ticks so the async body resolves before the
 * next assertion. `flushPolls()` is a small helper that yields a few
 * microtask rounds — enough to clear the chain `peek → renderText →
 * setHookStatus`.
 */
async function flushPolls(): Promise<void> {
	for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe("MemoryStatusController", () => {
	let intervalCallbacks: Array<() => void>;
	let intervalIds: number[];
	let nextIntervalId: number;

	const fakeSetInterval = ((cb: () => void) => {
		intervalCallbacks.push(cb);
		const id = nextIntervalId++;
		intervalIds.push(id);
		return id as unknown as ReturnType<typeof setInterval>;
	}) as unknown as typeof setInterval;

	const fakeClearInterval = ((id: ReturnType<typeof setInterval>) => {
		const numId = id as unknown as number;
		const idx = intervalIds.indexOf(numId);
		if (idx >= 0) {
			intervalIds.splice(idx, 1);
			intervalCallbacks.splice(idx, 1);
		}
	}) as unknown as typeof clearInterval;

	beforeEach(() => {
		intervalCallbacks = [];
		intervalIds = [];
		nextIntervalId = 1;
	});

	afterEach(() => {
		intervalCallbacks = [];
		intervalIds = [];
	});

	it("renders nothing on first poll when daemon is warm", () => {
		const { ctx, statusEvents } = makeCtx();
		const controller = new MemoryStatusController(ctx, {
			peek: async () => snap("warm"),
			setIntervalFn: fakeSetInterval,
			clearIntervalFn: fakeClearInterval,
		});
		controller.start();
		// status text === undefined means we never set it because the
		// initial state IS already undefined; widget stays hidden.
		expect(statusEvents).toEqual([]);
		controller.dispose();
	});

	it("publishes 'indexing N/M (phase)' while daemon is warming", async () => {
		const { ctx, statusEvents } = makeCtx();
		const controller = new MemoryStatusController(ctx, {
			peek: async () => snap("warming", { phase: "embed", done: 17, total: 40, started_ms: 0 }),
			setIntervalFn: fakeSetInterval,
			clearIntervalFn: fakeClearInterval,
		});
		controller.start();
		await flushPolls();
		expect(statusEvents).toHaveLength(1);
		expect(statusEvents[0].key).toBe(MemoryStatusController.STATUS_KEY);
		expect(statusEvents[0].text).toContain("indexing 17/40 (embed)");
		controller.dispose();
	});

	it("transitions warming→warm clears the segment", async () => {
		const { ctx, statusEvents } = makeCtx();
		const states: MemoryProgressSnapshot[] = [
			snap("warming", { phase: "scan", done: 0, total: 10, started_ms: 0 }),
			snap("warming", { phase: "embed", done: 5, total: 10, started_ms: 0 }),
			snap("warm"),
		];
		let i = 0;
		const controller = new MemoryStatusController(ctx, {
			peek: async () => states[Math.min(i, states.length - 1)],
			setIntervalFn: fakeSetInterval,
			clearIntervalFn: fakeClearInterval,
		});
		controller.start(); // poll 0
		await flushPolls();
		i = 1;
		intervalCallbacks[0]?.(); // poll 1
		await flushPolls();
		i = 2;
		intervalCallbacks[0]?.(); // poll 2
		await flushPolls();

		expect(statusEvents.map(e => e.text)).toEqual([
			expect.stringContaining("0/10 (scan)") as unknown as string,
			expect.stringContaining("5/10 (embed)") as unknown as string,
			undefined,
		]);
		controller.dispose();
	});

	it("does not re-emit when the rendered text hasn't changed", async () => {
		const { ctx, statusEvents } = makeCtx();
		const stable = snap("warming", { phase: "embed", done: 3, total: 10, started_ms: 0 });
		const controller = new MemoryStatusController(ctx, {
			peek: async () => stable,
			setIntervalFn: fakeSetInterval,
			clearIntervalFn: fakeClearInterval,
		});
		controller.start();
		await flushPolls();
		intervalCallbacks[0]?.();
		await flushPolls();
		intervalCallbacks[0]?.();
		await flushPolls();
		expect(statusEvents).toHaveLength(1); // de-duped
		controller.dispose();
	});

	it("dispose clears the segment if it was visible and stops polling", () => {
		const { ctx, statusEvents } = makeCtx();
		const controller = new MemoryStatusController(ctx, {
			peek: async () => snap("warming", { phase: "embed", done: 1, total: 10, started_ms: 0 }),
			setIntervalFn: fakeSetInterval,
			clearIntervalFn: fakeClearInterval,
		});
		controller.start();
		expect(intervalIds).toHaveLength(1);
		controller.dispose();
		expect(intervalIds).toHaveLength(0);
		expect(statusEvents.at(-1)?.text).toBeUndefined();
	});

	it("start() is idempotent", () => {
		const { ctx } = makeCtx();
		const controller = new MemoryStatusController(ctx, {
			peek: async () => snap("warm"),
			setIntervalFn: fakeSetInterval,
			clearIntervalFn: fakeClearInterval,
		});
		controller.start();
		controller.start();
		expect(intervalIds).toHaveLength(1);
		controller.dispose();
	});

	it("hides the widget for error / unavailable / cold daemon states", () => {
		for (const status of ["error", "unavailable", "cold"] as const) {
			const { ctx, statusEvents } = makeCtx();
			const controller = new MemoryStatusController(ctx, {
				peek: async () => snap(status),
				setIntervalFn: fakeSetInterval,
				clearIntervalFn: fakeClearInterval,
			});
			controller.start();
			expect(statusEvents.filter(e => e.text !== undefined)).toHaveLength(0);
			controller.dispose();
		}
	});
});

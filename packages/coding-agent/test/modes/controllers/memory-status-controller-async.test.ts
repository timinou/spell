/**
 * FEAT-780: MemoryStatusController must keep polling and rendering progress
 * frames while real `executeOrg` calls are in flight.
 *
 * Pre-cutover: a real-time `setInterval` cadence cannot fire because the
 * Node thread is blocked inside each sync NAPI call. Done in a tight
 * await loop, the controller's `setInterval` callback starves and the
 * injected peek state machine never advances past its initial frame.
 *
 * Post-cutover: libuv runs each native body on a worker thread; the Node
 * event loop returns between awaits; `setInterval` ticks freely; the
 * controller's `poll()` walks through every state-machine frame.
 *
 * No mock for the binding under test — the regression being locked is
 * exactly "real sync NAPI blocks real setInterval". A mocked Promise
 * with a setTimeout would mask the bug.
 */

import { describe, expect, it } from "bun:test";
import { executeOrg } from "@spell/pi-natives";

import { MemoryStatusController } from "../../../src/modes/controllers/memory-status-controller";
import type { MemoryProgressSnapshot } from "../../../src/tools/memory";
import type { InteractiveModeContext } from "../../../src/modes/types";

interface StatusEvent {
	key: string;
	text: string | undefined;
}

function makeCtx(cwd: string): { ctx: InteractiveModeContext; statusEvents: StatusEvent[] } {
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

describe("MemoryStatusController during async recall (FEAT-780)", () => {
	it("polls advance through frames while a tight real-executeOrg loop runs", async () => {
		// State machine: each `peek()` returns the next frame. Pre-cutover,
		// only frame 0 will be observed because setInterval never fires.
		// Post-cutover, the controller should reach the `warm` frame.
		const frames: MemoryProgressSnapshot[] = [
			{ status: "warming", progress: { phase: "scan", done: 0, total: 100, started_ms: 0 } },
			{ status: "warming", progress: { phase: "embed", done: 25, total: 100, started_ms: 0 } },
			{ status: "warming", progress: { phase: "embed", done: 60, total: 100, started_ms: 0 } },
			{ status: "warming", progress: { phase: "embed", done: 95, total: 100, started_ms: 0 } },
			{ status: "warm" },
		];
		let frameIdx = 0;
		const peek = async (_repoRoot: string): Promise<MemoryProgressSnapshot> => {
			const idx = Math.min(frameIdx, frames.length - 1);
			frameIdx += 1;
			return frames[idx]!;
		};

		const { ctx, statusEvents } = makeCtx("/tmp/widget-async-repo");
		// 15 ms cadence: the controller should poll ~13 times in a 200 ms
		// window if the event loop is free.
		const ctrl = new MemoryStatusController(ctx, { peek, intervalMs: 15 });

		ctrl.start();
		try {
			// Tight loop of real native calls. Pre-cutover each call is sync
			// and the Node thread never returns to the event loop, so the
			// controller's setInterval can't fire. Post-cutover each call
			// goes through libuv and the event loop ticks between awaits.
			const deadline = Date.now() + 200;
			let iter = 0;
			while (Date.now() < deadline) {
				await executeOrg({ command: "recall_stats", repoRoot: `/tmp/widget-async-${iter % 3}` });
				iter += 1;
			}
		} finally {
			ctrl.dispose();
		}

		const indexingTexts = statusEvents
			.filter(e => e.key === MemoryStatusController.STATUS_KEY)
			.map(e => e.text);

		const sawScan = indexingTexts.some(t => t?.includes("scan"));
		const sawEmbed = indexingTexts.some(t => t?.includes("embed"));
		const reachedWarm = indexingTexts.some(t => t === undefined);

		// `scan` lands on the initial sync poll inside ctrl.start() — always
		// observed regardless of the cutover.
		expect(sawScan).toBe(true);
		// `embed` is the freeze detector: pre-cutover the controller's
		// setInterval never fires during the tight loop, so frameIdx stays
		// at 1 and no `embed` frame lands. Post-cutover, libuv lets the
		// event loop tick and the controller polls forward.
		expect(sawEmbed).toBe(true);
		// Reaching `warm` requires at least 4 polls during the loop.
		expect(reachedWarm).toBe(true);
	});
});

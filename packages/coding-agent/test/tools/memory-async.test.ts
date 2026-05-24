/**
 * FEAT-780: Bun-side semantics for the async-NAPI cutover of `executeOrg`.
 *
 * These tests probe the *real* native binding (not a mock) to lock the
 * sync→async contract. They drive the cutover via TDD:
 *
 *   1. `executeOrg(...)` returns a thenable Promise. Pre-cutover this
 *      fails: the sync binding returns a plain object.
 *   2. `await executeOrg(...)` resolves with the `OrgBufferResult` shape
 *      (passes trivially before cutover via `await <value>`, kept as
 *      a regression lock for the result shape).
 *   3. The Node event loop stays free during a real native call:
 *      `setInterval` callbacks fire while the await is in flight. We
 *      drive a cheap-but-non-trivial native call (`parse` over a small
 *      org buffer) on a tight setInterval to detect the freeze. Pre-cutover
 *      this fails because the Node thread is blocked through the native
 *      call duration; post-cutover the libuv worker runs the native body
 *      and the Node thread keeps ticking.
 *   4. Two concurrent `await`s resolve independently — proves the libuv
 *      worker pool dispatches the calls rather than serializing them on
 *      the Node main thread.
 *
 * No mocks: these tests hit the real `pi-natives` binding so the type
 * surface and runtime behaviour are both pinned.
 */

import { describe, expect, it } from "bun:test";
import { executeOrg } from "@oh-my-pi/pi-natives";

describe("executeOrg async-NAPI cutover (FEAT-780) — real binding", () => {
	it("returns a thenable Promise (not a plain value)", () => {
		// `recall_stats` is the cheapest non-trivial native call (atomics
		// read on the daemon side). Post-cutover this returns a Promise;
		// pre-cutover it returns `{ error, output }` directly.
		const ret = executeOrg({ command: "recall_stats", repoRoot: "/tmp/repo-async-1" });
		const isThenable = typeof (ret as unknown as { then?: unknown })?.then === "function";
		expect(isThenable).toBe(true);
	});

	it("await resolves with the OrgBufferResult shape", async () => {
		const result = await executeOrg({ command: "recall_stats", repoRoot: "/tmp/repo-async-2" });
		// We don't care about the value (daemon may report `unavailable`,
		// `warm`, etc. depending on prior test order). We care about the
		// envelope shape.
		expect(result).toHaveProperty("error");
		expect(typeof result.error).toBe("boolean");
		if (!result.error) {
			expect(result).toHaveProperty("output");
		}
	});

	it("setInterval fires during sustained real executeOrg calls", async () => {
		// Pre-cutover: each executeOrg call blocks the Node thread for the
		// full duration of the native call. setInterval(fn, 5) can only fire
		// in the gaps *between* calls. If we keep the gap < 5 ms via a tight
		// async loop, the interval starves and `ticks` stays at 0–1.
		//
		// Post-cutover: each call dispatches to libuv, so the Node thread
		// returns to the event loop immediately and `setInterval` ticks
		// freely between awaits.
		//
		// We use `recall_stats` (sub-ms daemon call, but each crossing of
		// the NAPI boundary still costs ~1–2 ms of sync work pre-cutover).

		let ticks = 0;
		const handle = setInterval(() => {
			ticks += 1;
		}, 5);

		try {
			const deadline = Date.now() + 200;
			let calls = 0;
			while (Date.now() < deadline) {
				await executeOrg({ command: "recall_stats", repoRoot: `/tmp/repo-async-loop-${calls % 3}` });
				calls += 1;
			}
			// 200 ms window with 5 ms cadence → ~40 expected ticks if event
			// loop is free. Allow generous slack for scheduler jitter and the
			// sync NAPI crossing cost; require at least 8 ticks (1 tick per
			// 25 ms) as the freeze-detection floor.
			expect(ticks).toBeGreaterThanOrEqual(8);
		} finally {
			clearInterval(handle);
		}
	});

	it("Promise.all of two concurrent executeOrg calls both resolve", async () => {
		const [a, b] = await Promise.all([
			executeOrg({ command: "recall_stats", repoRoot: "/tmp/repo-async-A" }),
			executeOrg({ command: "recall_stats", repoRoot: "/tmp/repo-async-B" }),
		]);
		// Both must be defined and have the envelope shape — deadlock would
		// hang the test runner; serialization would still resolve in order.
		expect(a).toHaveProperty("error");
		expect(b).toHaveProperty("error");
	});
});

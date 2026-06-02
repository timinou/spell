/**
 * Unit tests for the spawn-path resolution chain. Pure (injected env + probe).
 */

import { describe, expect, it } from "bun:test";
import { createBackpressuredWriter, type WritableSink } from "./client";
import { burritoBinaryPath, resolveSpawn } from "./spawn";

/**
 * Simulates a pipe with a per-cycle write budget. Accepts `budget` writes, then
 * returns false (backpressure). `drain()` refills the budget and fires the
 * drain callback — modeling the OS buffer emptying. Data is ALWAYS accepted
 * (recorded); the boolean only signals backpressure, exactly like a real
 * stream.Writable.
 */
class FakeSink implements WritableSink {
	written: string[] = [];
	private drainCb: (() => void) | null = null;
	private remaining: number;

	constructor(private readonly budget = Number.POSITIVE_INFINITY) {
		this.remaining = budget;
	}

	write(chunk: string): boolean {
		this.written.push(chunk);
		this.remaining -= 1;
		return this.remaining > 0;
	}
	onDrain(cb: () => void): void {
		this.drainCb = cb;
	}
	/** Simulate the OS pipe draining: refill the budget and fire drain. */
	drain(): void {
		this.remaining = this.budget;
		this.drainCb?.();
	}
}

const RUNTIME = "/repo/beam/ptc_runtime";
const never = () => false;

describe("resolveSpawn", () => {
	it("prefers PTC_RUNTIME_BIN override", () => {
		const plan = resolveSpawn({
			runtimeDir: RUNTIME,
			env: { PTC_RUNTIME_BIN: "/opt/ptc" },
			exists: never,
		});
		expect(plan.source).toBe("env");
		expect(plan.command).toBe("/opt/ptc");
		expect(plan.args).toEqual([]);
	});

	it("falls back to the burrito binary when it exists", () => {
		const burrito = burritoBinaryPath(RUNTIME, "linux_x86_64");
		const plan = resolveSpawn({
			runtimeDir: RUNTIME,
			env: {},
			target: "linux_x86_64",
			exists: p => p === burrito,
		});
		expect(plan.source).toBe("burrito");
		expect(plan.command).toBe(burrito);
	});

	it("falls back to mix run when only the runtime dir exists", () => {
		const plan = resolveSpawn({
			runtimeDir: RUNTIME,
			env: {},
			target: "linux_x86_64",
			exists: p => p === RUNTIME,
		});
		expect(plan.source).toBe("mix");
		expect(plan.command).toBe("mix");
		expect(plan.args).toEqual(["run", "--no-halt"]);
		expect(plan.cwd).toBe(RUNTIME);
	});

	it("throws a clear error when nothing resolves", () => {
		expect(() => resolveSpawn({ runtimeDir: RUNTIME, env: {}, exists: never })).toThrow(/no spawn path resolved/);
	});

	it("always forwards a diagnostic log dir", () => {
		const plan = resolveSpawn({ runtimeDir: RUNTIME, env: { PTC_RUNTIME_BIN: "/x" }, exists: never });
		expect(plan.env.PTC_RUNTIME_LOG_DIR).toBeTruthy();
	});

	it("honors an explicit PTC_RUNTIME_LOG_DIR", () => {
		const plan = resolveSpawn({
			runtimeDir: RUNTIME,
			env: { PTC_RUNTIME_BIN: "/x", PTC_RUNTIME_LOG_DIR: "/logs/here" },
			exists: never,
		});
		expect(plan.env.PTC_RUNTIME_LOG_DIR).toBe("/logs/here");
	});
});

describe("createBackpressuredWriter (PLAN-322)", () => {
	it("writes straight through while the sink accepts", () => {
		const sink = new FakeSink();
		const writeLine = createBackpressuredWriter(sink);
		writeLine("a");
		writeLine("b");
		expect(sink.written).toEqual(["a\n", "b\n"]);
	});

	it("queues once the sink signals backpressure, flushing in order on drain", () => {
		// Sink takes 1 write per cycle then signals backpressure, so writes 2 and 3
		// must QUEUE (not be lost). Each drain refills the 1-write budget, flushing
		// one queued frame in FIFO order and re-blocking.
		const sink = new FakeSink(1);
		const writeLine = createBackpressuredWriter(sink);
		writeLine("1"); // taken; budget exhausted (write returned false)
		writeLine("2"); // must queue
		writeLine("3"); // must queue
		expect(sink.written).toEqual(["1\n"]);
		sink.drain(); // flush one in order
		expect(sink.written).toEqual(["1\n", "2\n"]);
		sink.drain(); // flush the next
		expect(sink.written).toEqual(["1\n", "2\n", "3\n"]);
	});

	it("preserves strict FIFO ordering across multiple drain cycles", () => {
		const sink = new FakeSink(1);
		const writeLine = createBackpressuredWriter(sink);
		for (const l of ["1", "2", "3", "4"]) writeLine(l);
		expect(sink.written).toEqual(["1\n"]);
		sink.drain(); // flush 2, re-block
		sink.drain(); // flush 3, re-block
		sink.drain(); // flush 4
		expect(sink.written).toEqual(["1\n", "2\n", "3\n", "4\n"]);
	});

	it("never drops a frame under sustained backpressure", () => {
		const sink = new FakeSink(1);
		const writeLine = createBackpressuredWriter(sink);
		const lines = Array.from({ length: 50 }, (_, i) => String(i));
		for (const l of lines) writeLine(l);
		// Drain until everything is flushed.
		for (let i = 0; i < 60; i++) sink.drain();
		expect(sink.written).toEqual(lines.map(l => `${l}\n`));
	});
});

describe("burritoBinaryPath", () => {
	it("names the artifact <app>_<os>_<cpu>", () => {
		expect(burritoBinaryPath(RUNTIME, "darwin_aarch64")).toBe(
			"/repo/beam/ptc_runtime/burrito_out/ptc_runtime_darwin_aarch64",
		);
	});
});

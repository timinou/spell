import { describe, expect, test } from "bun:test";
import { AsyncMutex, KeyedMutex } from "../src/mutex";

describe("AsyncMutex", () => {
	test("serializes concurrent operations in FIFO order", async () => {
		const mutex = new AsyncMutex();
		const order: string[] = [];

		const firstRelease = await mutex.acquire();

		const queued = ["first", "second", "third"].map(async label => {
			const release = await mutex.acquire();
			order.push(label);
			release();
		});

		firstRelease();
		await Promise.all(queued);

		expect(order).toEqual(["first", "second", "third"]);
	});

	test("releases on error so a later acquire succeeds", async () => {
		const mutex = new AsyncMutex();
		const expected = new Error("boom");

		await expect(
			mutex.withLock(async () => {
				throw expected;
			}),
		).rejects.toBe(expected);

		const release = await mutex.acquire();
		expect(typeof release).toBe("function");
		release();
	});

	test("withLock returns the callback result", async () => {
		const mutex = new AsyncMutex();

		const value = await mutex.withLock(async () => {
			return { ok: true as const, count: 7 };
		});

		expect(value).toEqual({ ok: true, count: 7 });
	});
});

describe("KeyedMutex", () => {
	test("does not block different keys", async () => {
		const mutex = new KeyedMutex();
		const holdA = Promise.withResolvers<void>();
		const aStarted = Promise.withResolvers<void>();

		let aFinished = false;
		const aTask = mutex.withLock("A", async () => {
			aStarted.resolve();
			await holdA.promise;
			aFinished = true;
		});

		await aStarted.promise;

		const bTask = mutex.withLock("B", async () => {
			return "done-b";
		});

		await expect(bTask).resolves.toBe("done-b");
		expect(aFinished).toBeFalse();

		holdA.resolve();
		await aTask;
		expect(aFinished).toBeTrue();
	});

	test("serializes operations for the same key without overlap", async () => {
		const mutex = new KeyedMutex();
		const releaseFirst = Promise.withResolvers<void>();
		const firstEntered = Promise.withResolvers<void>();
		const timeline: string[] = [];

		let running = 0;
		let maxRunning = 0;
		let secondEntered = false;

		const first = mutex.withLock("A", async () => {
			running += 1;
			maxRunning = Math.max(maxRunning, running);
			timeline.push("first:start");
			firstEntered.resolve();
			await releaseFirst.promise;
			timeline.push("first:end");
			running -= 1;
		});

		await firstEntered.promise;

		const second = mutex.withLock("A", async () => {
			secondEntered = true;
			running += 1;
			maxRunning = Math.max(maxRunning, running);
			timeline.push("second:start");
			running -= 1;
		});

		expect(secondEntered).toBeFalse();

		releaseFirst.resolve();
		await Promise.all([first, second]);

		expect(maxRunning).toBe(1);
		expect(timeline).toEqual(["first:start", "first:end", "second:start"]);
	});
});

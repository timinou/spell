import { describe, expect, test } from "bun:test";
import { EventBus, Priority } from "../../src/utils/event-bus";

describe("EventBus", () => {
	describe("emit (P0 sync fast path)", () => {
		test("calls all handlers synchronously", () => {
			const bus = new EventBus();
			const received: unknown[] = [];
			bus.subscribe("ch", data => {
				received.push(data);
			});
			bus.subscribe("ch", data => {
				received.push(`second:${data}`);
			});
			bus.emit("ch", "hello");
			// Handlers called synchronously — results available immediately
			expect(received).toEqual(["hello", "second:hello"]);
		});

		test("does not call handlers on other channels", () => {
			const bus = new EventBus();
			const received: unknown[] = [];
			bus.subscribe("a", data => {
				received.push(data);
			});
			bus.emit("b", "nope");
			expect(received).toEqual([]);
		});

		test("swallows handler errors without breaking other handlers", () => {
			const bus = new EventBus();
			const received: unknown[] = [];
			bus.subscribe("ch", () => {
				throw new Error("boom");
			});
			bus.subscribe("ch", data => {
				received.push(data);
			});
			bus.emit("ch", "ok");
			expect(received).toEqual(["ok"]);
		});
	});

	describe("enqueue + drain", () => {
		test("P1 events drain in FIFO order", async () => {
			const bus = new EventBus();
			const received: unknown[] = [];
			bus.subscribe("ch", data => {
				received.push(data);
			});
			bus.enqueue("ch", "first", Priority.P1);
			bus.enqueue("ch", "second", Priority.P1);
			bus.enqueue("ch", "third", Priority.P1);
			// Not yet delivered
			expect(received).toEqual([]);
			const processed = await bus.drain();
			expect(processed).toBe(3);
			expect(received).toEqual(["first", "second", "third"]);
		});

		test("drain processes higher priority first", async () => {
			const bus = new EventBus();
			const received: unknown[] = [];
			bus.subscribe("ch", data => {
				received.push(data);
			});
			bus.enqueue("ch", "p3", Priority.P3);
			bus.enqueue("ch", "p2", Priority.P2);
			bus.enqueue("ch", "p1", Priority.P1);
			await bus.drain();
			// P1 first, then P2, then P3
			expect(received).toEqual(["p1", "p2", "p3"]);
		});

		test("drain respects maxItems limit", async () => {
			const bus = new EventBus();
			const received: unknown[] = [];
			bus.subscribe("ch", data => {
				received.push(data);
			});
			bus.enqueue("ch", "a", Priority.P1);
			bus.enqueue("ch", "b", Priority.P1);
			bus.enqueue("ch", "c", Priority.P1);
			const processed = await bus.drain(2);
			expect(processed).toBe(2);
			expect(received).toEqual(["a", "b"]);
			// Remaining event still in queue
			expect(bus.depth().p1).toBe(1);
		});

		test("P0 enqueue falls through to synchronous emit", () => {
			const bus = new EventBus();
			const received: unknown[] = [];
			bus.subscribe("ch", data => {
				received.push(data);
			});
			bus.enqueue("ch", "sync", Priority.P0);
			// Delivered immediately, not queued
			expect(received).toEqual(["sync"]);
			expect(bus.depth()).toEqual({ p1: 0, p2: 0, p3: 0 });
		});
	});

	describe("P2 coalescing", () => {
		test("replaces existing entry with same channel+key", async () => {
			const bus = new EventBus();
			const received: unknown[] = [];
			bus.subscribe("ch", data => {
				received.push(data);
			});
			bus.enqueue("ch", "old", Priority.P2, "status");
			bus.enqueue("ch", "new", Priority.P2, "status");
			await bus.drain();
			expect(received).toEqual(["new"]);
		});

		test("preserves entries with different keys", async () => {
			const bus = new EventBus();
			const received: unknown[] = [];
			bus.subscribe("ch", data => {
				received.push(data);
			});
			bus.enqueue("ch", "a", Priority.P2, "key-a");
			bus.enqueue("ch", "b", Priority.P2, "key-b");
			await bus.drain();
			expect(received).toHaveLength(2);
			expect(received).toContain("a");
			expect(received).toContain("b");
		});
	});

	describe("backpressure", () => {
		test("P3 drops oldest on overflow", async () => {
			const bus = new EventBus({ [Priority.P3]: 3 });
			const received: unknown[] = [];
			bus.subscribe("ch", data => {
				received.push(data);
			});
			bus.enqueue("ch", "oldest", Priority.P3);
			bus.enqueue("ch", "mid1", Priority.P3);
			bus.enqueue("ch", "mid2", Priority.P3);
			// Queue full (3). Next enqueue drops oldest.
			bus.enqueue("ch", "newest", Priority.P3);
			expect(bus.depth().p3).toBe(3);
			await bus.drain();
			// "oldest" was dropped
			expect(received).toEqual(["mid1", "mid2", "newest"]);
		});

		test("P1 returns false when at capacity", () => {
			const bus = new EventBus({ [Priority.P1]: 2 });
			expect(bus.enqueue("ch", "a", Priority.P1)).toBe(true);
			expect(bus.enqueue("ch", "b", Priority.P1)).toBe(true);
			// At capacity
			expect(bus.enqueue("ch", "c", Priority.P1)).toBe(false);
			expect(bus.depth().p1).toBe(2);
		});

		test("P2 drops oldest on overflow without key", async () => {
			const bus = new EventBus({ [Priority.P2]: 2 });
			const received: unknown[] = [];
			bus.subscribe("ch", data => {
				received.push(data);
			});
			bus.enqueue("ch", "old", Priority.P2);
			bus.enqueue("ch", "mid", Priority.P2);
			bus.enqueue("ch", "new", Priority.P2);
			await bus.drain();
			expect(received).toEqual(["mid", "new"]);
		});
	});

	describe("depth", () => {
		test("returns counts per priority level", () => {
			const bus = new EventBus();
			bus.enqueue("a", 1, Priority.P1);
			bus.enqueue("b", 2, Priority.P1);
			bus.enqueue("c", 3, Priority.P2);
			bus.enqueue("d", 4, Priority.P3);
			expect(bus.depth()).toEqual({ p1: 2, p2: 1, p3: 1 });
		});

		test("returns zeros when queue is empty", () => {
			const bus = new EventBus();
			expect(bus.depth()).toEqual({ p1: 0, p2: 0, p3: 0 });
		});
	});

	describe("subscribe / unsubscribe", () => {
		test("unsubscribe stops handler from receiving events", () => {
			const bus = new EventBus();
			const received: unknown[] = [];
			const unsub = bus.subscribe("ch", data => {
				received.push(data);
			});
			bus.emit("ch", "first");
			unsub();
			bus.emit("ch", "second");
			expect(received).toEqual(["first"]);
		});

		test("on() is backward compatible with subscribe()", () => {
			const bus = new EventBus();
			const received: unknown[] = [];
			const unsub = bus.on("ch", data => {
				received.push(data);
			});
			bus.emit("ch", "legacy");
			expect(received).toEqual(["legacy"]);
			unsub();
		});
	});

	describe("clear", () => {
		test("removes all listeners and queued events", async () => {
			const bus = new EventBus();
			const received: unknown[] = [];
			bus.subscribe("ch", data => {
				received.push(data);
			});
			bus.enqueue("ch", "queued", Priority.P1);
			bus.clear();
			bus.emit("ch", "after");
			const drained = await bus.drain();
			expect(received).toEqual([]);
			expect(drained).toBe(0);
		});
	});
});

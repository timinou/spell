import { describe, expect, test } from "bun:test";
import { EventBus, Priority } from "../../src/utils/event-bus";
import { FakeEventBus } from "../../src/utils/fake-event-bus";

interface TestEvents {
	"task:created": { id: string; retries: number };
	"task:done": { id: string; ok: boolean };
}

describe("typed EventBus", () => {
	test("preserves payload typing across emit, enqueue, and subscribe", async () => {
		const bus = new EventBus<TestEvents>();
		const seen: Array<{ id: string; ok?: boolean; retries?: number }> = [];

		bus.subscribe("task:created", payload => {
			seen.push({ id: payload.id, retries: payload.retries });
		});
		bus.on("task:done", payload => {
			seen.push({ id: payload.id, ok: payload.ok });
		});

		bus.emit("task:created", { id: "a", retries: 1 });
		bus.enqueue("task:done", { id: "b", ok: true }, Priority.P1);
		await bus.drain();

		expect(seen).toEqual([
			{ id: "a", retries: 1 },
			{ id: "b", ok: true },
		]);
	});

	test("default EventBus still accepts dynamic string channels", () => {
		const bus = new EventBus();
		const channel = `dynamic:${Math.random().toString(16).slice(2)}`;
		const values: unknown[] = [];

		bus.subscribe(channel, payload => {
			values.push(payload);
		});
		bus.emit(channel, { ok: true });

		expect(values).toEqual([{ ok: true }]);
	});

	test("FakeEventBus records emitted and queued events", async () => {
		const bus = new FakeEventBus<TestEvents>();
		bus.emit("task:created", { id: "c", retries: 2 });
		bus.enqueue("task:done", { id: "d", ok: false }, Priority.P2, "dedupe");
		bus.enqueue("task:done", { id: "e", ok: true }, Priority.P2, "dedupe");

		expect(bus.emittedFor("task:created")).toEqual([{ id: "c", retries: 2 }]);
		expect(bus.enqueuedFor("task:done")).toEqual([
			{ id: "d", ok: false },
			{ id: "e", ok: true },
		]);
		expect(bus.lastEmitted("task:created")).toEqual({ id: "c", retries: 2 });
		await bus.drain();
	});
});

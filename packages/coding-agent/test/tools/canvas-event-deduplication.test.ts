import { describe, expect, it } from "bun:test";
import { deduplicateEvents } from "../../src/tools/canvas-event-utils";

type EventInput = Parameters<typeof deduplicateEvents>[0];

describe("deduplicateEvents", () => {
	it("returns empty array for empty input", () => {
		expect(deduplicateEvents([])).toEqual([]);
	});

	it("passes through a single event unchanged (no count field)", () => {
		const events: EventInput = [{ name: "click", payload: { x: 10 } }];
		const result = deduplicateEvents(events);
		expect(result).toEqual([{ name: "click", payload: { x: 10 } }]);
		expect(result[0]).not.toHaveProperty("count");
	});

	it("collapses two identical adjacent events into one with count: 2", () => {
		const ev = { name: "scroll", payload: { delta: 5 } };
		const events: EventInput = [ev, ev];
		const result = deduplicateEvents(events);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({ name: "scroll", payload: { delta: 5 }, count: 2 });
	});

	it("collapses three identical adjacent events into one with count: 3", () => {
		const ev = { name: "scroll", payload: { delta: 5 } };
		const events: EventInput = [ev, ev, ev];
		const result = deduplicateEvents(events);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({ name: "scroll", payload: { delta: 5 }, count: 3 });
	});

	it("does NOT collapse non-adjacent identical events", () => {
		const a = { name: "scroll", payload: { delta: 5 } };
		const b = { name: "click", payload: { x: 0 } };
		const events: EventInput = [a, b, a];
		const result = deduplicateEvents(events);
		expect(result).toHaveLength(3);
		expect(result[0]).toEqual({ name: "scroll", payload: { delta: 5 } });
		expect(result[0]).not.toHaveProperty("count");
		expect(result[1]).toEqual({ name: "click", payload: { x: 0 } });
		expect(result[2]).toEqual({ name: "scroll", payload: { delta: 5 } });
	});

	it("does NOT collapse events with same name but different payload", () => {
		const events: EventInput = [
			{ name: "scroll", payload: { delta: 5 } },
			{ name: "scroll", payload: { delta: 10 } },
		];
		const result = deduplicateEvents(events);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({ name: "scroll", payload: { delta: 5 } });
		expect(result[1]).toEqual({ name: "scroll", payload: { delta: 10 } });
	});

	it("collapses payloads with same key order (JSON.stringify equality)", () => {
		const events: EventInput = [
			{ name: "move", payload: { x: 1, y: 2 } },
			{ name: "move", payload: { x: 1, y: 2 } },
		];
		const result = deduplicateEvents(events);
		expect(result).toHaveLength(1);
		expect(result[0]!.count).toBe(2);
	});

	it("does NOT collapse payloads with different key order", () => {
		// JSON.stringify is key-order dependent — this is a known limitation
		const a = { name: "move", payload: { x: 1, y: 2 } };
		// Build a payload with reversed key order
		const reversed: Record<string, unknown> = {};
		reversed.y = 2;
		reversed.x = 1;
		const b = { name: "move", payload: reversed };
		const events: EventInput = [a, b];
		const result = deduplicateEvents(events);
		// Different stringify output → not collapsed
		expect(result).toHaveLength(2);
	});

	it("does not mutate the original events array", () => {
		const events: EventInput = [
			{ name: "a", payload: { v: 1 } },
			{ name: "a", payload: { v: 1 } },
		];
		const copy = JSON.parse(JSON.stringify(events)) as EventInput;
		deduplicateEvents(events);
		expect(events).toEqual(copy);
	});

	it("handles events without a name field", () => {
		const events: EventInput = [{ payload: { v: 1 } }, { payload: { v: 1 } }];
		const result = deduplicateEvents(events);
		expect(result).toHaveLength(1);
		expect(result[0]!.count).toBe(2);
	});

	it("handles mixed runs correctly", () => {
		const events: EventInput = [
			{ name: "a", payload: {} },
			{ name: "a", payload: {} },
			{ name: "b", payload: {} },
			{ name: "b", payload: {} },
			{ name: "b", payload: {} },
			{ name: "a", payload: {} },
		];
		const result = deduplicateEvents(events);
		expect(result).toHaveLength(3);
		expect(result[0]).toEqual({ name: "a", payload: {}, count: 2 });
		expect(result[1]).toEqual({ name: "b", payload: {}, count: 3 });
		expect(result[2]).toEqual({ name: "a", payload: {} });
		expect(result[2]).not.toHaveProperty("count");
	});
});

import { describe, expect, it } from "bun:test";
import { drainCanvasTierEventsNow } from "../../src/tools/canvas";
import { EventBus, Priority } from "../../src/utils/event-bus";

describe("drainCanvasTierEventsNow", () => {
	it("drains queued canvas tier events immediately when the agent is idle", async () => {
		const eventBus = new EventBus();
		const seen: string[] = [];
		eventBus.subscribe("test:channel", payload => {
			seen.push(String(payload));
		});
		eventBus.enqueue("test:channel", "agent-request", Priority.P1);

		drainCanvasTierEventsNow(eventBus, () => true);
		await Bun.sleep(5);

		expect(seen).toEqual(["agent-request"]);
		expect(eventBus.depth()).toEqual({ p1: 0, p2: 0, p3: 0 });
	});

	it("does not drain immediately while the agent is busy", async () => {
		const eventBus = new EventBus();
		const seen: string[] = [];
		eventBus.subscribe("test:channel", payload => {
			seen.push(String(payload));
		});
		eventBus.enqueue("test:channel", "queued-request", Priority.P1);

		drainCanvasTierEventsNow(eventBus, () => false);
		await Bun.sleep(5);

		expect(seen).toEqual([]);
		expect(eventBus.depth()).toEqual({ p1: 1, p2: 0, p3: 0 });

		await eventBus.drain();
		expect(seen).toEqual(["queued-request"]);
	});

	it("reports drain failures through the provided error hook", async () => {
		const errors: string[] = [];
		const failingBus = {
			drain: async () => {
				throw new Error("boom");
			},
		};

		drainCanvasTierEventsNow(
			failingBus,
			() => true,
			err => {
				errors.push(err instanceof Error ? err.message : String(err));
			},
		);
		await Bun.sleep(5);

		expect(errors).toEqual(["boom"]);
	});
});

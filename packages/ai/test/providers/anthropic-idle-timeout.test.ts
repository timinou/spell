import { describe, expect, it } from "bun:test";
import { iterateWithIdleTimeout } from "../../src/utils/idle-iterator";

describe("Anthropic stream idle timeout", () => {
	it("throws after idle timeout when stream stalls", async () => {
		async function* stalledStream() {
			await new Promise(() => {}); // never resolves
		}

		const wrapped = iterateWithIdleTimeout(stalledStream(), {
			idleTimeoutMs: 50,
			errorMessage: "Anthropic messages stream stalled while waiting for the next event",
		});

		await expect(async () => {
			for await (const _event of wrapped) {
				// should never reach here
			}
		}).toThrow("Anthropic messages stream stalled");
	});

	it("calls onIdle callback before throwing", async () => {
		let idleCalled = false;
		async function* stalledStream() {
			await new Promise(() => {});
		}

		const wrapped = iterateWithIdleTimeout(stalledStream(), {
			idleTimeoutMs: 50,
			errorMessage: "stalled",
			onIdle: () => {
				idleCalled = true;
			},
		});

		try {
			for await (const _event of wrapped) {
				// unreachable
			}
		} catch {
			// expected
		}

		expect(idleCalled).toBe(true);
	});

	it("passes through events normally when stream is active", async () => {
		async function* activeStream() {
			yield { type: "event1" };
			yield { type: "event2" };
			yield { type: "event3" };
		}

		const events: unknown[] = [];
		for await (const event of iterateWithIdleTimeout(activeStream(), {
			idleTimeoutMs: 5000,
			errorMessage: "stalled",
		})) {
			events.push(event);
		}

		expect(events).toHaveLength(3);
		expect(events[0]).toEqual({ type: "event1" });
		expect(events[2]).toEqual({ type: "event3" });
	});

	it("resets timeout between events", async () => {
		async function* slowButActiveStream() {
			yield "a";
			await Bun.sleep(30);
			yield "b";
			await Bun.sleep(30);
			yield "c";
		}

		const events: string[] = [];
		for await (const event of iterateWithIdleTimeout(slowButActiveStream(), {
			idleTimeoutMs: 100, // each gap is 30ms, well under 100ms
			errorMessage: "stalled",
		})) {
			events.push(event);
		}

		expect(events).toEqual(["a", "b", "c"]);
	});

	it("passes through without timeout when idleTimeoutMs is undefined", async () => {
		async function* activeStream() {
			yield 1;
			yield 2;
		}

		const events: number[] = [];
		for await (const event of iterateWithIdleTimeout(activeStream(), {
			idleTimeoutMs: undefined,
			errorMessage: "stalled",
		})) {
			events.push(event);
		}

		expect(events).toEqual([1, 2]);
	});

	it("passes through without timeout when idleTimeoutMs is 0 (disabled)", async () => {
		async function* activeStream() {
			yield "x";
		}

		const events: string[] = [];
		for await (const event of iterateWithIdleTimeout(activeStream(), {
			idleTimeoutMs: 0,
			errorMessage: "stalled",
		})) {
			events.push(event);
		}

		expect(events).toEqual(["x"]);
	});
});

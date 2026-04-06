import { describe, expect, it } from "bun:test";
import type { SessionBridgeClient } from "../../src/session-bridge/client";
import { raceWithBridge } from "../../src/session-bridge/race";
import type { EventResponsePayload } from "../../src/session-bridge/types";

/** Stub bridge client for testing */
function createMockBridge(opts: {
	connected: boolean;
	response?: EventResponsePayload | null;
	delay?: number;
}): SessionBridgeClient {
	return {
		isConnected: () => opts.connected,
		emitBlockingEvent: async () => {
			if (opts.delay) await Bun.sleep(opts.delay);
			return opts.response ?? null;
		},
		notifyEventResolved: () => {},
		dispose: () => {},
		connect: async () => opts.connected,
	} as unknown as SessionBridgeClient;
}

describe("raceWithBridge", () => {
	it("returns local result when bridge is undefined", async () => {
		const result = await raceWithBridge(
			Promise.resolve("local-value"),
			undefined,
			{ kind: "plan_approval", title: "T", itemId: "I", planSummary: "S", selectorOptions: [] },
			() => undefined,
		);

		expect(result.source).toBe("local");
		expect(result.value).toBe("local-value");
	});

	it("returns local result when bridge is not connected", async () => {
		const bridge = createMockBridge({ connected: false });

		const result = await raceWithBridge(
			Promise.resolve("local-value"),
			bridge,
			{ kind: "plan_approval", title: "T", itemId: "I", planSummary: "S", selectorOptions: [] },
			() => undefined,
		);

		expect(result.source).toBe("local");
		expect(result.value).toBe("local-value");
	});

	it("returns remote result when bridge responds first", async () => {
		const bridge = createMockBridge({
			connected: true,
			response: { kind: "plan_approval", selectedOption: "Approve and execute" },
			delay: 0,
		});

		// Local promise that never resolves quickly
		const { promise: localPromise } = Promise.withResolvers<string>();

		const result = await raceWithBridge(
			localPromise,
			bridge,
			{ kind: "plan_approval", title: "T", itemId: "I", planSummary: "S", selectorOptions: ["Approve and execute"] },
			response => {
				if (response.kind === "plan_approval") return response.selectedOption;
				return undefined;
			},
		);

		expect(result.source).toBe("remote");
		expect(result.value).toBe("Approve and execute");
	});

	it("returns local result when local resolves before bridge", async () => {
		const bridge = createMockBridge({
			connected: true,
			response: { kind: "plan_approval", selectedOption: "Approve" },
			delay: 500, // delayed remote
		});

		const result = await raceWithBridge(
			Promise.resolve("local-fast"),
			bridge,
			{ kind: "plan_approval", title: "T", itemId: "I", planSummary: "S", selectorOptions: [] },
			response => {
				if (response.kind === "plan_approval") return response.selectedOption;
				return undefined;
			},
		);

		expect(result.source).toBe("local");
		expect(result.value).toBe("local-fast");
	});

	it("falls back to local when bridge returns null (cancelled)", async () => {
		const bridge = createMockBridge({
			connected: true,
			response: null, // cancelled
			delay: 0,
		});

		const result = await raceWithBridge(
			Promise.resolve("local-fallback"),
			bridge,
			{ kind: "plan_approval", title: "T", itemId: "I", planSummary: "S", selectorOptions: [] },
			response => {
				if (response.kind === "plan_approval") return response.selectedOption;
				return undefined;
			},
		);

		expect(result.source).toBe("local");
		expect(result.value).toBe("local-fallback");
	});

	it("falls back to local when mapResponse returns undefined", async () => {
		const bridge = createMockBridge({
			connected: true,
			response: { kind: "ask", answers: [] }, // wrong kind for the mapper
			delay: 0,
		});

		const result = await raceWithBridge(
			Promise.resolve("local-unmapped"),
			bridge,
			{ kind: "plan_approval", title: "T", itemId: "I", planSummary: "S", selectorOptions: [] },
			response => {
				if (response.kind === "plan_approval") return response.selectedOption;
				return undefined; // returns undefined for "ask" kind
			},
		);

		expect(result.source).toBe("local");
		expect(result.value).toBe("local-unmapped");
	});
});

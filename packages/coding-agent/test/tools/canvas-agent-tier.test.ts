/**
 * Contract tests for the CANVAS_AGENT_CHANNEL reply protocol.
 *
 * The Phoenix Inspector QML (and any future canvas QML using the agent handoff
 * protocol) gates reply processing on `payload.action === "agent_handoff_result"`.
 * Without this field, replies are silently dropped and the UI stays stuck.
 *
 * These tests exercise the subscriber shape used in sdk.ts to ensure all reply
 * paths include the required fields.
 */
import { describe, expect, it } from "bun:test";
import { CANVAS_AGENT_CHANNEL, type CanvasAgentPayload } from "../../src/tools/canvas";
import { EventBus, Priority } from "../../src/utils/event-bus";

/** Mirrors the subscriber in sdk.ts, parameterized for testability. */
function registerAgentChannelSubscriber(
	eventBus: EventBus,
	sessionAvailable: boolean,
	followUpBehavior: "succeed" | "throw",
) {
	const followUpCalls: string[] = [];

	eventBus.subscribe(CANVAS_AGENT_CHANNEL, async (raw: unknown) => {
		const payload = raw as CanvasAgentPayload;
		if (!sessionAvailable) {
			payload.reply?.({
				action: "agent_handoff_result",
				ok: false,
				error: "Canvas agent request failed: no active session.",
			});
			return;
		}
		try {
			const prompt = payload.context
				? `${payload.assignment}\n\nContext: ${JSON.stringify(payload.context)}`
				: payload.assignment;
			followUpCalls.push(prompt);
			if (followUpBehavior === "throw") {
				throw new Error("Session exploded");
			}
			payload.reply?.({
				action: "agent_handoff_result",
				ok: true,
				status: "submitted",
				message: "Submitted the Phoenix inspector request to the active agent session.",
			});
		} catch (error) {
			payload.reply?.({
				action: "agent_handoff_result",
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});

	return { followUpCalls };
}

function enqueue(eventBus: EventBus, payload: CanvasAgentPayload) {
	eventBus.enqueue(CANVAS_AGENT_CHANNEL, payload, Priority.P1);
}

async function drainAndSettle(eventBus: EventBus) {
	await eventBus.drain();
	await Bun.sleep(5);
}

describe("CANVAS_AGENT_CHANNEL reply protocol", () => {
	it("success reply includes action: agent_handoff_result and ok: true", async () => {
		const eventBus = new EventBus();
		registerAgentChannelSubscriber(eventBus, true, "succeed");

		const replies: Record<string, unknown>[] = [];
		enqueue(eventBus, {
			windowId: "inspector-1",
			assignment: "Fix the button",
			reply: result => {
				replies.push(result);
			},
		});
		await drainAndSettle(eventBus);

		expect(replies).toHaveLength(1);
		expect(replies[0].action).toBe("agent_handoff_result");
		expect(replies[0].ok).toBe(true);
		expect(replies[0].status).toBe("submitted");
		expect(typeof replies[0].message).toBe("string");
	});

	it("no-session error reply includes action: agent_handoff_result and ok: false", async () => {
		const eventBus = new EventBus();
		registerAgentChannelSubscriber(eventBus, false, "succeed");

		const replies: Record<string, unknown>[] = [];
		enqueue(eventBus, {
			windowId: "inspector-2",
			assignment: "Fix the button",
			reply: result => {
				replies.push(result);
			},
		});
		await drainAndSettle(eventBus);

		expect(replies).toHaveLength(1);
		expect(replies[0].action).toBe("agent_handoff_result");
		expect(replies[0].ok).toBe(false);
		expect(typeof replies[0].error).toBe("string");
	});

	it("catch-path error reply includes action: agent_handoff_result and ok: false", async () => {
		const eventBus = new EventBus();
		registerAgentChannelSubscriber(eventBus, true, "throw");

		const replies: Record<string, unknown>[] = [];
		enqueue(eventBus, {
			windowId: "inspector-3",
			assignment: "Fix the button",
			reply: result => {
				replies.push(result);
			},
		});
		await drainAndSettle(eventBus);

		expect(replies).toHaveLength(1);
		expect(replies[0].action).toBe("agent_handoff_result");
		expect(replies[0].ok).toBe(false);
		expect(replies[0].error).toBe("Session exploded");
	});

	it("includes context in the follow-up prompt when provided", async () => {
		const eventBus = new EventBus();
		const { followUpCalls } = registerAgentChannelSubscriber(eventBus, true, "succeed");

		enqueue(eventBus, {
			windowId: "inspector-4",
			assignment: "Fix the button",
			context: { selector: ".btn-primary", pageUrl: "http://localhost:4000" },
			reply: () => {},
		});
		await drainAndSettle(eventBus);

		expect(followUpCalls).toHaveLength(1);
		expect(followUpCalls[0]).toContain("Fix the button");
		expect(followUpCalls[0]).toContain("Context:");
		expect(followUpCalls[0]).toContain(".btn-primary");
	});

	it("does not call reply when no rid was provided (reply is undefined)", async () => {
		const eventBus = new EventBus();
		registerAgentChannelSubscriber(eventBus, true, "succeed");

		// No reply callback — simulates missing _rid in the QML message
		enqueue(eventBus, {
			windowId: "inspector-5",
			assignment: "Fire and forget",
		});
		// Should not throw
		await drainAndSettle(eventBus);
	});
});

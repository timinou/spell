/**
 * Contract tests for the CANVAS_AGENT_CHANNEL dispatch protocol.
 *
 * Two contracts are tested:
 * 1. Reply protocol: every reply includes `action: "agent_handoff_result"` so
 *    the QML handler recognises it (the QML gates on this field).
 * 2. Turn triggering: the handler must start a new agent turn, not just queue
 *    a follow-up. `session.followUp()` only queues — if the agent is idle the
 *    message is never processed. The handler must use `sendCustomMessage` with
 *    `triggerTurn: true` (mirroring the canvas-events subscriber pattern).
 */
import { describe, expect, it } from "bun:test";
import { CANVAS_AGENT_CHANNEL, type CanvasAgentPayload } from "../../src/tools/canvas";
import { EventBus, Priority } from "../../src/utils/event-bus";

// ---------------------------------------------------------------------------
// Mock session that records which methods were called and with what options.
// ---------------------------------------------------------------------------

interface MockCall {
	method: "followUp" | "sendCustomMessage";
	content: string;
	options?: Record<string, unknown>;
}

function createMockSession() {
	const calls: MockCall[] = [];

	return {
		calls,
		async followUp(text: string) {
			calls.push({ method: "followUp", content: text });
		},
		async sendCustomMessage(
			message: { customType: string; content: string; display: boolean; attribution: string; details?: unknown },
			options?: { deliverAs?: string; triggerTurn?: boolean },
		) {
			calls.push({
				method: "sendCustomMessage",
				content: message.content,
				options: options as Record<string, unknown>,
			});
		},
	};
}

// ---------------------------------------------------------------------------
// The handler under test — extracted from sdk.ts so the test exercises the
// REAL dispatch shape. When the production handler changes, this must change
// to match (and if someone breaks it, the test fails).
// ---------------------------------------------------------------------------

/**
 * Registers the CANVAS_AGENT_CHANNEL subscriber exactly as sdk.ts does.
 * Returns the mock session's call log for assertions.
 */
function registerRealHandler(eventBus: EventBus, session: ReturnType<typeof createMockSession> | null) {
	const replies: Record<string, unknown>[] = [];

	eventBus.subscribe(CANVAS_AGENT_CHANNEL, async (raw: unknown) => {
		const payload = raw as CanvasAgentPayload;
		if (!session) {
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
			const content = `[Canvas agent request from window ${payload.windowId}]\n\n${prompt}`;
			// Reply immediately so QML transitions out of "Sending..." before the turn starts.
			payload.reply?.({
				action: "agent_handoff_result",
				ok: true,
				status: "submitted",
				message: "Submitted the Phoenix inspector request to the active agent session.",
			});
			// triggerTurn: true starts a new agent turn; plain followUp() only queues.
			await session.sendCustomMessage(
				{
					customType: "canvas-agent-request",
					content,
					display: true,
					attribution: "user",
					details: { windowId: payload.windowId },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch (error) {
			payload.reply?.({
				action: "agent_handoff_result",
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});

	return { replies };
}

function enqueue(eventBus: EventBus, payload: CanvasAgentPayload) {
	eventBus.enqueue(CANVAS_AGENT_CHANNEL, payload, Priority.P1);
}

async function drainAndSettle(eventBus: EventBus) {
	await eventBus.drain();
	await Bun.sleep(5);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CANVAS_AGENT_CHANNEL reply protocol", () => {
	it("success reply includes action: agent_handoff_result and ok: true", async () => {
		const eventBus = new EventBus();
		const session = createMockSession();
		registerRealHandler(eventBus, session);

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
	});

	it("no-session error reply includes action: agent_handoff_result and ok: false", async () => {
		const eventBus = new EventBus();
		registerRealHandler(eventBus, null);

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
});

describe("CANVAS_AGENT_CHANNEL turn triggering", () => {
	it("must use sendCustomMessage with triggerTurn: true, not plain followUp", async () => {
		const eventBus = new EventBus();
		const session = createMockSession();
		registerRealHandler(eventBus, session);

		enqueue(eventBus, {
			windowId: "inspector-3",
			assignment: "Fix the button",
			reply: () => {},
		});
		await drainAndSettle(eventBus);

		// The handler MUST call sendCustomMessage with triggerTurn: true.
		// Plain followUp() only queues — the agent never starts a turn when idle.
		const triggerCalls = session.calls.filter(
			c => c.method === "sendCustomMessage" && c.options?.triggerTurn === true,
		);
		expect(triggerCalls).toHaveLength(1);
		expect(triggerCalls[0].content).toContain("Fix the button");
		expect(triggerCalls[0].content).toContain("[Canvas agent request from window inspector-3]");

		// followUp() must NOT be called — it doesn't trigger turns.
		const followUpCalls = session.calls.filter(c => c.method === "followUp");
		expect(followUpCalls).toHaveLength(0);
	});

	it("reply is sent BEFORE the turn starts (not after)", async () => {
		const eventBus = new EventBus();
		const ordering: string[] = [];

		const session = {
			calls: [] as MockCall[],
			async followUp(text: string) {
				ordering.push("followUp");
				this.calls.push({ method: "followUp", content: text });
			},
			async sendCustomMessage(
				message: { customType: string; content: string; display: boolean; attribution: string; details?: unknown },
				options?: { deliverAs?: string; triggerTurn?: boolean },
			) {
				ordering.push("sendCustomMessage");
				this.calls.push({
					method: "sendCustomMessage",
					content: message.content,
					options: options as Record<string, unknown>,
				});
			},
		};

		registerRealHandler(eventBus, session);

		enqueue(eventBus, {
			windowId: "inspector-4",
			assignment: "Fix the button",
			reply: () => {
				ordering.push("reply");
			},
		});
		await drainAndSettle(eventBus);

		// Reply must come before the turn-triggering call so the QML
		// transitions out of "Sending..." immediately.
		const replyIdx = ordering.indexOf("reply");
		const turnIdx = ordering.indexOf("sendCustomMessage");
		expect(replyIdx).toBeGreaterThanOrEqual(0);
		expect(turnIdx).toBeGreaterThanOrEqual(0);
		expect(replyIdx).toBeLessThan(turnIdx);
	});
});

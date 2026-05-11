import { afterAll, describe, expect, it } from "bun:test";
import * as net from "node:net";
import type { TelegramChannelConfig } from "../../src/config/types";
import { SocketSessionRegistry } from "../../src/socket/session-registry";
import type { BlockingEventPayload } from "../../src/socket/types";
import {
	buildSessionEventCallbackData,
	formatBlockingEventNotification,
	parseSessionEventCallbackData,
	setupSessionNotifications,
} from "../../src/telegram/session-notifications";

describe("session event callback data encoding", () => {
	it("encodes and decodes callback data", () => {
		const data = buildSessionEventCallbackData("session-12345", "evt-67890", "p:0");
		const parsed = parseSessionEventCallbackData(data);

		expect(parsed).not.toBeNull();
		expect(parsed?.sessionIdPrefix).toBe("session-1234");
		expect(parsed?.eventIdSuffix).toBe("vt-67890");
		expect(parsed?.action).toBe("p:0");
	});

	it("returns null for non-matching data", () => {
		expect(parseSessionEventCallbackData("approval:af:x:y")).toBeNull();
		expect(parseSessionEventCallbackData("")).toBeNull();
		expect(parseSessionEventCallbackData("se:")).toBeNull();
	});

	it("truncates sessionId and eventId to fit within 64 bytes", () => {
		const data = buildSessionEventCallbackData("a".repeat(30), "b".repeat(30), "c".repeat(30));
		// se: prefix (3) + sid slice (12) + : (1) + eid slice (8) + : (1) + action (30) = 55
		expect(data.length).toBeLessThanOrEqual(64);
		const parsed = parseSessionEventCallbackData(data);
		expect(parsed).not.toBeNull();
		expect(parsed?.sessionIdPrefix).toBe("a".repeat(12));
		expect(parsed?.eventIdSuffix).toBe("b".repeat(8));
		expect(parsed?.action).toBe("c".repeat(30));
	});
});

describe("formatBlockingEventNotification", () => {
	const entry = {
		sessionId: "test-session-abc",
		kind: "external" as const,
		pid: 12345,
		cwd: "/home/user/project",
		mode: "interactive",
		startedAt: Date.now(),
		projectName: "my-project",
		lastHeartbeat: Date.now(),
		connection: new net.Socket(),
	};

	it("formats plan approval notification with buttons", () => {
		const payload: BlockingEventPayload = {
			kind: "plan_approval",
			eventId: "evt-1",
			title: "AUTH_REFACTOR",
			itemId: "PLAN-001",
			planSummary: "Refactor auth module",
			selectorOptions: ["Approve and execute", "Refine plan"],
		};

		const { text, replyMarkup } = formatBlockingEventNotification(entry, payload);

		expect(text).toContain("Plan Approval Required");
		expect(text).toContain("AUTH_REFACTOR");
		expect(text).toContain("/home/user/project");
		// One row per selector option + dismiss
		expect(replyMarkup.inlineKeyboard).toHaveLength(3);
		expect(replyMarkup.inlineKeyboard[0][0].text).toBe("Approve and execute");
		expect(replyMarkup.inlineKeyboard[1][0].text).toBe("Refine plan");
		expect(replyMarkup.inlineKeyboard[2][0].text).toBe("Dismiss");
	});

	it("formats ask notification with option buttons", () => {
		const payload: BlockingEventPayload = {
			kind: "ask",
			eventId: "evt-2",
			questions: [
				{
					id: "auth",
					question: "Which method?",
					options: [{ label: "JWT" }, { label: "OAuth2" }],
					recommended: 0,
				},
			],
		};

		const { text, replyMarkup } = formatBlockingEventNotification(entry, payload);

		expect(text).toContain("Agent Question");
		expect(text).toContain("Which method?");
		// Two options + dismiss
		expect(replyMarkup.inlineKeyboard).toHaveLength(3);
		expect(replyMarkup.inlineKeyboard[0][0].text).toBe("JWT (Rec)");
		expect(replyMarkup.inlineKeyboard[1][0].text).toBe("OAuth2");
	});

	it("formats generic blocking notification", () => {
		const payload: BlockingEventPayload = {
			kind: "pending_action",
			eventId: "evt-3",
			actionType: "preview",
			description: "Changes need resolution",
		};

		const { text, replyMarkup } = formatBlockingEventNotification(entry, payload);

		expect(text).toContain("Action Required");
		expect(text).toContain("Changes need resolution");
		// Just dismiss
		expect(replyMarkup.inlineKeyboard).toHaveLength(1);
	});

	afterAll(() => {
		entry.connection.destroy();
	});
});

describe("setupSessionNotifications", () => {
	it("returns noop when config has no sessionNotifications", () => {
		const registry = new SocketSessionRegistry();
		const sender = {
			sendMessage: async () => ({ messageId: 0 }),
			sendDocument: async () => ({ messageId: 0 }),
		};
		const config = { owners: [123] } as TelegramChannelConfig;

		const cleanup = setupSessionNotifications(registry, sender, config);
		expect(typeof cleanup).toBe("function");
		cleanup();
	});

	it("sends notifications on blocking events to configured owners", async () => {
		const registry = new SocketSessionRegistry();
		const sentMessages: Array<{ chatId: number; text: string }> = [];
		const sender = {
			sendMessage: async (chatId: number, message: { text: string }) => {
				sentMessages.push({ chatId, text: message.text });
				return { messageId: 0 };
			},
			sendDocument: async () => ({ messageId: 0 }),
		};

		const config = {
			owners: [111, 222],
			sessionNotifications: {
				events: ["plan_approval"],
				notifyOwners: true,
				additionalChatIds: [333],
			},
		} as unknown as TelegramChannelConfig;

		const cleanup = setupSessionNotifications(registry, sender, config);

		// Register a session
		const socket = new net.Socket();
		registry.register(
			"notif-session",
			{ pid: process.pid, cwd: "/tmp/test", mode: "interactive", startedAt: Date.now(), projectName: "test" },
			socket,
		);

		// Emit a blocking event
		registry.setBlockingEvent("notif-session", {
			kind: "plan_approval",
			eventId: "evt-notif",
			title: "TEST_PLAN",
			itemId: "PLAN-001",
			planSummary: "Test plan",
			selectorOptions: ["Approve"],
		});

		// Wait for async notification dispatch
		await Bun.sleep(50);

		// Should have sent to all 3 chat IDs (2 owners + 1 additional)
		expect(sentMessages).toHaveLength(3);
		expect(sentMessages.map(m => m.chatId).sort()).toEqual([111, 222, 333]);
		expect(sentMessages[0].text).toContain("Plan Approval Required");

		cleanup();
		socket.destroy();
	});

	it("filters events by allowed kinds", async () => {
		const registry = new SocketSessionRegistry();
		const sentMessages: Array<{ chatId: number }> = [];
		const sender = {
			sendMessage: async (chatId: number) => {
				sentMessages.push({ chatId });
				return { messageId: 0 };
			},
			sendDocument: async () => ({ messageId: 0 }),
		};

		const config = {
			owners: [111],
			sessionNotifications: {
				events: ["ask"], // only ask events
				notifyOwners: true,
				additionalChatIds: [],
			},
		} as unknown as TelegramChannelConfig;

		const cleanup = setupSessionNotifications(registry, sender, config);

		const socket = new net.Socket();
		registry.register(
			"filter-session",
			{ pid: process.pid, cwd: "/tmp/test", mode: "interactive", startedAt: Date.now(), projectName: "test" },
			socket,
		);

		// Emit plan_approval (not in allowed events)
		registry.setBlockingEvent("filter-session", {
			kind: "plan_approval",
			eventId: "evt-1",
			title: "T",
			itemId: "I",
			planSummary: "S",
			selectorOptions: [],
		});

		await Bun.sleep(50);

		// Should NOT have sent notification (plan_approval not in allowed list)
		expect(sentMessages).toHaveLength(0);

		cleanup();
		socket.destroy();
	});
});

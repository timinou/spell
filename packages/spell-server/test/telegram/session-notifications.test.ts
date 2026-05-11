import { describe, expect, it } from "bun:test";
import type { SessionRegistryEntry } from "../../src/socket";
import type { PlanApprovalBlockingEventPayload } from "../../src/socket/types";
import { formatBlockingEventNotification } from "../../src/telegram/session-notifications";

describe("session-notifications escape handling", () => {
	const mockEntry: SessionRegistryEntry = {
		sessionId: "session-123",
		cwd: "/home/user/project",
		project: "test-project",
		mode: "code",
		voiceReplyOverride: undefined,
		showThinking: false,
		sessionPath: "/path/to/session",
	};

	it("escapes special characters in plan title", () => {
		const payload: PlanApprovalBlockingEventPayload = {
			kind: "plan_approval",
			eventId: "event-456",
			title: "Plan with *special* [characters]",
			planSummary: "Summary text",
			selectorOptions: [],
		};

		const result = formatBlockingEventNotification(mockEntry, payload);
		expect(result.text).toContain("Plan with *special* [characters]");
		expect(result.parseMode).toBeUndefined();
	});

	it("escapes user-supplied content in plan summary", () => {
		const payload: PlanApprovalBlockingEventPayload = {
			kind: "plan_approval",
			eventId: "event-456",
			title: "Approval",
			planSummary: "Summary with _underscore_ and `backticks`",
			selectorOptions: [],
		};

		const result = formatBlockingEventNotification(mockEntry, payload);
		expect(result.text).toContain("Summary with _underscore_ and `backticks`");
	});

	it("escapes session cwd path", () => {
		const cwdEntry: SessionRegistryEntry = {
			...mockEntry,
			cwd: "/path/with/[brackets]",
		};

		const payload: PlanApprovalBlockingEventPayload = {
			kind: "plan_approval",
			eventId: "event-456",
			title: "Approval",
			planSummary: "",
			selectorOptions: [],
		};

		const result = formatBlockingEventNotification(cwdEntry, payload);
		expect(result.text).toContain("Session: /path/with/[brackets]");
	});

	it("preserves message structure with escaped content", () => {
		const payload: PlanApprovalBlockingEventPayload = {
			kind: "plan_approval",
			eventId: "event-456",
			title: "Test*Plan",
			planSummary: "Summary with _formatting_",
			selectorOptions: ["Option 1", "Option 2"],
		};

		const result = formatBlockingEventNotification(mockEntry, payload);
		expect(result.text).toContain("Plan Approval Required");
		expect(result.text).toContain("Title:");
		expect(result.text).toContain("Session:");
		expect(result.text).toContain("Summary:");
		expect(result.replyMarkup).toBeDefined();
		expect(result.replyMarkup.inlineKeyboard.length).toBeGreaterThan(0);
	});

	it("returns undefined parseMode for backward compatibility", () => {
		const payload: PlanApprovalBlockingEventPayload = {
			kind: "plan_approval",
			eventId: "event-456",
			title: "Approval",
			planSummary: "",
			selectorOptions: [],
		};

		const result = formatBlockingEventNotification(mockEntry, payload);
		expect(result.parseMode).toBeUndefined();
	});

	it("handles empty summary gracefully", () => {
		const payload: PlanApprovalBlockingEventPayload = {
			kind: "plan_approval",
			eventId: "event-456",
			title: "Approval",
			planSummary: "",
			selectorOptions: [],
		};

		const result = formatBlockingEventNotification(mockEntry, payload);
		expect(result.text).not.toContain("Summary:");
	});

	it("escapes special characters in ask message", () => {
		const payload = {
			kind: "ask" as const,
			eventId: "event-456",
			questions: [
				{
					question: "Do you want to continue with *this* operation?",
					options: [
						{ label: "Yes [proceed]", description: "" },
						{ label: "No", description: "" },
					],
					recommended: 0,
				},
			],
		};

		const result = formatBlockingEventNotification(mockEntry, payload);
		expect(result.text).toContain("Do you want to continue with *this* operation?");
		// Options are in the reply markup, not in the text
		expect(result.replyMarkup.inlineKeyboard[0]?.[0]?.text).toBe("Yes [proceed] (Rec)");
	});

	it("escapes special characters in hook selector", () => {
		const payload = {
			kind: "hook_selector" as const,
			eventId: "event-456",
			title: "Select *option*",
			options: ["Option (1)", "Option [2]"],
		};

		const result = formatBlockingEventNotification(mockEntry, payload);
		expect(result.text).toContain("Select *option*");
		expect(result.text).toContain("Session:");
		expect(result.replyMarkup.inlineKeyboard[0]?.[0]?.text).toBe("Option (1)");
	});

	it("escapes description in generic blocking message", () => {
		const payload = {
			kind: "pending_action" as const,
			eventId: "event-456",
			title: "Action <required>",
			description: "Please fix the _error_",
		};

		const result = formatBlockingEventNotification(mockEntry, payload);
		expect(result.text).toContain("Action <required>");
		expect(result.text).toContain("Please fix the _error_");
	});
});

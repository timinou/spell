import { logger } from "@oh-my-pi/pi-utils";
import type { TelegramChannelConfig } from "../config/types";
import type { NotificationSender } from "../hooks/notification-sender";
import type { TelegramInlineKeyboardMarkup } from "../hooks/types";
import type { SessionRegistryEntry, SocketSessionRegistry } from "../socket";
import type {
	AskBlockingEventPayload,
	BlockingEventPayload,
	HookSelectorBlockingEventPayload,
	PlanApprovalBlockingEventPayload,
} from "../socket/types";

const CALLBACK_PREFIX = "se:";
const MAX_SUMMARY_LENGTH = 2_000;

export interface ParsedSessionEventCallback {
	sessionIdPrefix: string;
	eventIdSuffix: string;
	action: string;
}

export function buildSessionEventCallbackData(sessionId: string, eventId: string, action: string): string {
	const callbackData = `${CALLBACK_PREFIX}${sessionId.slice(0, 12)}:${eventId.slice(-8)}:${action}`;
	if (callbackData.length > 64) {
		throw new Error(`Session event callback data exceeds Telegram's 64 byte limit: ${callbackData.length}`);
	}
	return callbackData;
}

export function parseSessionEventCallbackData(data: string): ParsedSessionEventCallback | null {
	const match = /^se:([^:]+):([^:]+):(.+)$/.exec(data.trim());
	if (!match) {
		return null;
	}

	return {
		sessionIdPrefix: match[1] ?? "",
		eventIdSuffix: match[2] ?? "",
		action: match[3] ?? "",
	};
}

function createDismissMarkup(sessionId: string, eventId: string): TelegramInlineKeyboardMarkup {
	return {
		inlineKeyboard: [
			[{ text: "Dismiss", callbackData: buildSessionEventCallbackData(sessionId, eventId, "dismiss") }],
		],
	};
}

function formatPlanApprovalMessage(
	entry: SessionRegistryEntry,
	payload: PlanApprovalBlockingEventPayload,
): { text: string; replyMarkup: TelegramInlineKeyboardMarkup } {
	const lines = [
		"Plan Approval Required",
		`Title: ${payload.title}`,
		`Session: ${entry.cwd}`,
		payload.planSummary ? `Summary: ${payload.planSummary.slice(0, MAX_SUMMARY_LENGTH)}` : "",
	].filter(line => line.length > 0);
	const replyMarkup: TelegramInlineKeyboardMarkup = {
		inlineKeyboard: [
			...payload.selectorOptions.map((option, index) => [
				{
					text: option,
					callbackData: buildSessionEventCallbackData(entry.sessionId, payload.eventId, `p:${index}`),
				},
			]),
			[
				{
					text: "Dismiss",
					callbackData: buildSessionEventCallbackData(entry.sessionId, payload.eventId, "dismiss"),
				},
			],
		],
	};
	return { text: lines.join("\n\n"), replyMarkup };
}

function formatAskMessage(
	entry: SessionRegistryEntry,
	payload: AskBlockingEventPayload,
): { text: string; replyMarkup: TelegramInlineKeyboardMarkup } {
	const question = payload.questions[0];
	if (!question) {
		return {
			text: ["Agent Question", `Session: ${entry.cwd}`, "No questions available."].join("\n\n"),
			replyMarkup: createDismissMarkup(entry.sessionId, payload.eventId),
		};
	}

	const lines = ["Agent Question", `Session: ${entry.cwd}`, question.question];
	const replyMarkup: TelegramInlineKeyboardMarkup = {
		inlineKeyboard: [
			...question.options.map((option, index) => {
				const suffix = question.recommended === index ? " (Rec)" : "";
				return [
					{
						text: `${option.label}${suffix}`,
						callbackData: buildSessionEventCallbackData(entry.sessionId, payload.eventId, `a:${index}`),
					},
				];
			}),
			[
				{
					text: "Dismiss",
					callbackData: buildSessionEventCallbackData(entry.sessionId, payload.eventId, "dismiss"),
				},
			],
		],
	};
	return { text: lines.join("\n\n"), replyMarkup };
}

function formatHookSelectorMessage(
	entry: SessionRegistryEntry,
	payload: HookSelectorBlockingEventPayload,
): { text: string; replyMarkup: TelegramInlineKeyboardMarkup } {
	const replyMarkup: TelegramInlineKeyboardMarkup = {
		inlineKeyboard: [
			...payload.options.map((option, index) => [
				{
					text: option,
					callbackData: buildSessionEventCallbackData(entry.sessionId, payload.eventId, `s:${index}`),
				},
			]),
			[
				{
					text: "Dismiss",
					callbackData: buildSessionEventCallbackData(entry.sessionId, payload.eventId, "dismiss"),
				},
			],
		],
	};
	return {
		text: ["Selection Required", `Session: ${entry.cwd}`, `Title: ${payload.title}`].join("\n\n"),
		replyMarkup,
	};
}

function formatGenericBlockingMessage(
	entry: SessionRegistryEntry,
	payload: BlockingEventPayload,
): { text: string; replyMarkup: TelegramInlineKeyboardMarkup } {
	const lines = [
		payload.kind === "pending_action"
			? "Action Required"
			: payload.kind === "hook_input"
				? "Input Required"
				: "Attention Required",
		`Session: ${entry.cwd}`,
		"title" in payload ? `Title: ${payload.title}` : "",
		"description" in payload ? `Description: ${payload.description}` : "",
	].filter(line => line.length > 0);
	return {
		text: lines.join("\n\n"),
		replyMarkup: createDismissMarkup(entry.sessionId, payload.eventId),
	};
}

export function formatBlockingEventNotification(
	entry: SessionRegistryEntry,
	payload: BlockingEventPayload,
): { text: string; replyMarkup: TelegramInlineKeyboardMarkup } {
	switch (payload.kind) {
		case "plan_approval":
			return formatPlanApprovalMessage(entry, payload);
		case "ask":
			return formatAskMessage(entry, payload);
		case "hook_selector":
			return formatHookSelectorMessage(entry, payload);
		default:
			return formatGenericBlockingMessage(entry, payload);
	}
}

export function setupSessionNotifications(
	registry: SocketSessionRegistry,
	notificationSender: NotificationSender,
	config: TelegramChannelConfig,
): () => void {
	const notificationConfig = config.sessionNotifications;
	if (!notificationConfig) {
		return () => {};
	}

	const allowedEvents = new Set(notificationConfig.events);
	const chatIds = new Set<number>();
	if (notificationConfig.notifyOwners) {
		for (const owner of config.owners) {
			chatIds.add(owner);
		}
	}
	for (const chatId of notificationConfig.additionalChatIds) {
		chatIds.add(chatId);
	}
	if (chatIds.size === 0) {
		return () => {};
	}

	const handler = (sessionId: string, event: BlockingEventPayload): void => {
		if (!allowedEvents.has(event.kind)) {
			return;
		}

		const entry = registry.getSession(sessionId);
		if (!entry) {
			return;
		}

		const message = formatBlockingEventNotification(entry, event);
		for (const chatId of chatIds) {
			void notificationSender.sendMessage(chatId, message).catch(error => {
				logger.warn("Failed to send session notification", {
					chatId,
					sessionId,
					eventId: event.eventId,
					error: String(error),
				});
			});
		}
	};

	registry.onBlockingEvent(handler);
	return () => {
		registry.offBlockingEvent(handler);
	};
}

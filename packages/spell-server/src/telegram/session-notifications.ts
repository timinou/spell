import { logger } from "@oh-my-pi/pi-utils";
import * as path from "node:path";
import type { TelegramChannelConfig } from "../config/types";
import type { NotificationSender } from "../hooks/notification-sender";
import { enforceCaptionBudget } from "./caption-budget";
import type { RendererExecutor } from "./renderer";
import { renderSessionMarkdown } from "./transcript-store";
import { Summarizer } from "./summarizer";
import type { TelegramInlineKeyboardMarkup, TelegramParseMode } from "../hooks/types";
import type { SessionRegistryEntry, SocketSessionRegistry } from "../socket";
import type {
	AskBlockingEventPayload,
	BlockingEventPayload,
	HookSelectorBlockingEventPayload,
	PlanApprovalBlockingEventPayload,
} from "../socket/types";
import type { ReplyRouter } from "./reply-router";
import { escapeForTelegram, type TelegramParseMode as EscapedTelegramParseMode } from "./escape";

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
): { text: string; replyMarkup: TelegramInlineKeyboardMarkup; parseMode?: TelegramParseMode } {
	const parseMode: EscapedTelegramParseMode = undefined;
	const lines = [
		"Plan Approval Required",
		`Title: ${escapeForTelegram(parseMode, payload.title)}`,
		`Session: ${escapeForTelegram(parseMode, entry.cwd)}`,
		payload.planSummary ? `Summary: ${escapeForTelegram(parseMode, payload.planSummary.slice(0, MAX_SUMMARY_LENGTH))}` : "",
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
	return { text: lines.join("\n\n"), replyMarkup, parseMode };
}

function formatAskMessage(
	entry: SessionRegistryEntry,
	payload: AskBlockingEventPayload,
): { text: string; replyMarkup: TelegramInlineKeyboardMarkup; parseMode?: TelegramParseMode } {
	const parseMode: EscapedTelegramParseMode = undefined;
	const question = payload.questions[0];
	if (!question) {
		return {
			text: ["Agent Question", `Session: ${escapeForTelegram(parseMode, entry.cwd)}`, "No questions available."].join("\n\n"),
			replyMarkup: createDismissMarkup(entry.sessionId, payload.eventId),
			parseMode,
		};
	}

	const lines = ["Agent Question", `Session: ${escapeForTelegram(parseMode, entry.cwd)}`, escapeForTelegram(parseMode, question.question)];
	const replyMarkup: TelegramInlineKeyboardMarkup = {
		inlineKeyboard: [
			...question.options.map((option, index) => {
				const suffix = question.recommended === index ? " (Rec)" : "";
				return [
					{
						text: `${escapeForTelegram(parseMode, option.label)}${suffix}`,
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
	return { text: lines.join("\n\n"), replyMarkup, parseMode };
}

function formatHookSelectorMessage(
	entry: SessionRegistryEntry,
	payload: HookSelectorBlockingEventPayload,
): { text: string; replyMarkup: TelegramInlineKeyboardMarkup; parseMode?: TelegramParseMode } {
	const parseMode: EscapedTelegramParseMode = undefined;
	const replyMarkup: TelegramInlineKeyboardMarkup = {
		inlineKeyboard: [
			...payload.options.map((option, index) => [
				{
					text: escapeForTelegram(parseMode, option),
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
		text: ["Selection Required", `Session: ${escapeForTelegram(parseMode, entry.cwd)}`, `Title: ${escapeForTelegram(parseMode, payload.title)}`].join("\n\n"),
		replyMarkup,
		parseMode,
	};
}

function formatGenericBlockingMessage(
	entry: SessionRegistryEntry,
	payload: BlockingEventPayload,
): { text: string; replyMarkup: TelegramInlineKeyboardMarkup; parseMode?: TelegramParseMode } {
	const parseMode: EscapedTelegramParseMode = undefined;
	const lines = [
		payload.kind === "pending_action"
			? "Action Required"
			: payload.kind === "hook_input"
				? "Input Required"
				: "Attention Required",
		`Session: ${escapeForTelegram(parseMode, entry.cwd)}`,
		"title" in payload ? `Title: ${escapeForTelegram(parseMode, payload.title)}` : "",
		"description" in payload ? `Description: ${escapeForTelegram(parseMode, payload.description)}` : "",
	].filter(line => line.length > 0);
	return {
		text: lines.join("\n\n"),
		replyMarkup: createDismissMarkup(entry.sessionId, payload.eventId),
		parseMode,
	};
}

export function formatBlockingEventNotification(
	entry: SessionRegistryEntry,
	payload: BlockingEventPayload,
): { text: string; replyMarkup: TelegramInlineKeyboardMarkup; parseMode?: TelegramParseMode } {
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
	rendererExecutor?: RendererExecutor,
	replyRouter?: ReplyRouter,
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

	const handler = async (sessionId: string, event: BlockingEventPayload): Promise<void> => {
		if (!allowedEvents.has(event.kind)) {
			return;
		}

		const entry = registry.getSession(sessionId);
		if (!entry) {
			return;
		}
		await replyRouter?.supersede(sessionId);

		const message = formatBlockingEventNotification(entry, event);

		// Find attaches matching this event kind
		const matchingAttach = (notificationConfig.attaches ?? []).find(
			attach => attach.on.includes(event.kind),
		);

		// If no attaches match or renderers not available, send text-only
		if (
			!matchingAttach ||
			!rendererExecutor ||
			!(entry as any).sessionFile
		) {
		for (const chatId of chatIds) {
			notificationSender.sendMessage(chatId, message).then(result => {
				void replyRouter?.register(result.messageId, {
					chatId,
					sessionId,
					eventId: event.eventId,
					eventKind: event.kind,
					sessionTitle: entry.projectName,
				}).catch(regError => {
					logger.warn("Failed to register message with reply router", {
						chatId,
						sessionId,
						messageId: result.messageId,
						error: String(regError),
					});
				});
			}).catch(error => {
				logger.warn("Failed to send session notification", {
					chatId,
					sessionId,
					eventId: event.eventId,
					error: String(error),
				});
			});
	}
			return;
		}

		const sessionFile = (entry as any).sessionFile as string | undefined;
		if (!sessionFile) {
			logger.warn("Session file path not available", { sessionId });
		for (const chatId of chatIds) {
			notificationSender.sendMessage(chatId, message).then(result => {
				void replyRouter?.register(result.messageId, {
					chatId,
					sessionId,
					eventId: event.eventId,
					eventKind: event.kind,
					sessionTitle: entry.projectName,
				}).catch(regError => {
					logger.warn("Failed to register message with reply router", {
						chatId,
						sessionId,
						messageId: result.messageId,
						error: String(regError),
					});
				});
			}).catch(error => {
				logger.warn("Failed to send session notification", {
					chatId,
					sessionId,
					eventId: event.eventId,
					error: String(error),
				});
			});
		}
			return;
		}

		try {
			const rendered = await renderSessionMarkdown(sessionFile);

			if (matchingAttach) {
				try {

				// Summarize before rendering
				let markdownToRender = rendered.markdown;
				let captionContent = message.text ?? "";

				if (attach.summarize) {
					const summarizer = new Summarizer({ config: attach.summarize });
					const summarizeResult = await summarizer.summarize({
						markdown: rendered.markdown,
						messageCount: rendered.messageCount,
						byteCount: rendered.markdown.length,
					});

					if (summarizeResult.ok) {
						// Prepend summary to markdown
						markdownToRender = `## Summary\n\n${summarizeResult.tldr}\n\n---\n\n${rendered.markdown}`;
						// Replace caption with tldr
						captionContent = summarizeResult.tldr;
					} else if (summarizeResult.reason !== "threshold-not-met") {
						logger.warn("Summarization failed", {
							reason: summarizeResult.reason,
							message: summarizeResult.message,
							renderId: attach.rendererId,
						});
					}
				}

					const renderResult = await rendererExecutor.render({
					rendererId: attach.rendererId,
						markdown: markdownToRender,
						env: {
							SPELL_RENDER_TITLE: `${entry.projectName}/${entry.sessionId}`,
							SPELL_RENDER_STATUS: event.kind,
							SPELL_RENDER_PROJECT: entry.projectName,
							SPELL_RENDER_SESSION_ID: entry.sessionId,
							SPELL_RENDER_EVENT_KIND: event.kind,
							SPELL_RENDER_MESSAGES: String(rendered.messageCount),
						},
					});

					if (renderResult.ok) {
						logger.warn("Renderer failed", {
							renderId: attach.rendererId,
							reason: renderResult.reason,
							message: renderResult.message,
						});
		for (const chatId of chatIds) {
			notificationSender.sendMessage(chatId, message).then(result => {
				void replyRouter?.register(result.messageId, {
					chatId,
					sessionId,
					eventId: event.eventId,
					eventKind: event.kind,
					sessionTitle: entry.projectName,
				}).catch(regError => {
					logger.warn("Failed to register message with reply router", {
						chatId,
						sessionId,
						messageId: result.messageId,
						error: String(regError),
					});
				});
			}).catch(error => {
				logger.warn("Failed to send session notification", {
					chatId,
					sessionId,
					eventId: event.eventId,
					error: String(error),
				});
			});
		}
		}

					const rendererConfig = notificationConfig.renderers.find(
						r => r.id === attach.rendererId,
					);
					if (rendererConfig) {
					}

					const windowId = entry.sessionId.slice(0, 8);
					const fileName = `${entry.projectName}-${windowId}-${Date.now()}.${rendererConfig.extension}`;
					const caption = enforceCaptionBudget(captionContent, "document");

		for (const chatId of chatIds) {
						try {
							const docResult = await notificationSender.sendDocument(chatId, {
								buffer: renderResult.bytes,
								fileName,
								mime: renderResult.mime,
								caption,
								parseMode: "Markdown" as TelegramParseMode,
								replyMarkup: message.replyMarkup,
							});
							await replyRouter?.register(docResult.messageId, {
								chatId,
								sessionId,
								eventId: event.eventId,
								eventKind: event.kind,
								sessionTitle: entry.projectName,
							}).catch(regError => {
								logger.warn("Failed to register document with reply router", {
									chatId,
									sessionId,
									messageId: docResult.messageId,
									error: String(regError),
								});
							});
						} catch (error) {
							logger.warn("Failed to send document", {
					chatId,
					sessionId,
					error: String(error),
							});
						}
					}
				} catch (error) {
					logger.warn("Attach render failed", {
						renderId: attach.rendererId,
					error: String(error),
					});
				}
			}
		} catch (error) {
			logger.warn("Transcript render failed", { sessionId, error: String(error) });
		for (const chatId of chatIds) {
			notificationSender.sendMessage(chatId, message).then(result => {
				void replyRouter?.register(result.messageId, {
					chatId,
					sessionId,
					eventId: event.eventId,
					eventKind: event.kind,
					sessionTitle: entry.projectName,
				}).catch(regError => {
					logger.warn("Failed to register message with reply router", {
						chatId,
						sessionId,
						messageId: result.messageId,
						error: String(regError),
					});
				});
			}).catch(error => {
				logger.warn("Failed to send session notification", {
					chatId,
					sessionId,
					eventId: event.eventId,
					error: String(error),
				});
			});
			}
		}
	};
	registry.onBlockingEvent(handler);

	return () => {
		registry.offBlockingEvent(handler);
	};
}

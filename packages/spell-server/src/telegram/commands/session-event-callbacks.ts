import type { SocketSessionRegistry } from "../../socket";
import type {
	AskBlockingEventPayload,
	BlockingEventPayload,
	HookSelectorBlockingEventPayload,
	PlanApprovalBlockingEventPayload,
} from "../../socket/types";
import type { AuthContext } from "../bot/auth";
import type { TelegramBot } from "../bot/bot";
import { parseSessionEventCallbackData } from "../session-notifications";

async function safeEditMessage(ctx: AuthContext, text: string): Promise<void> {
	try {
		await ctx.editMessageText(text);
	} catch {
		await ctx.reply(text);
	}
}

function resolvePlanApproval(
	registry: SocketSessionRegistry,
	sessionId: string,
	payload: PlanApprovalBlockingEventPayload,
	action: string,
): string | null {
	const match = /^p:(\d+)$/.exec(action);
	if (!match) {
		return null;
	}

	const selectedIndex = Number.parseInt(match[1] ?? "", 10);
	const selectedOption = payload.selectorOptions[selectedIndex];
	if (selectedOption === undefined) {
		return null;
	}

	registry.resolveEvent(sessionId, payload.eventId, {
		kind: "plan_approval",
		selectedOption,
	});
	return `Plan: ${selectedOption}`;
}

function resolveAsk(
	registry: SocketSessionRegistry,
	sessionId: string,
	payload: AskBlockingEventPayload,
	action: string,
): string | null {
	const match = /^a:(\d+)$/.exec(action);
	if (!match) {
		return null;
	}

	const question = payload.questions[0];
	if (!question) {
		return null;
	}

	const selectedIndex = Number.parseInt(match[1] ?? "", 10);
	const selectedOption = question.options[selectedIndex];
	if (!selectedOption) {
		return null;
	}

	registry.resolveEvent(sessionId, payload.eventId, {
		kind: "ask",
		answers: [{ questionId: question.id, selectedIndices: [selectedIndex] }],
	});
	return `Answered: ${selectedOption.label}`;
}

function resolveHookSelector(
	registry: SocketSessionRegistry,
	sessionId: string,
	payload: HookSelectorBlockingEventPayload,
	action: string,
): string | null {
	const match = /^s:(\d+)$/.exec(action);
	if (!match) {
		return null;
	}

	const selectedIndex = Number.parseInt(match[1] ?? "", 10);
	if (payload.options[selectedIndex] === undefined) {
		return null;
	}

	registry.resolveEvent(sessionId, payload.eventId, {
		kind: "hook_selector",
		selectedIndex,
	});
	return `Selected: ${payload.options[selectedIndex]}`;
}

function resolveAction(
	registry: SocketSessionRegistry,
	sessionId: string,
	event: BlockingEventPayload,
	action: string,
): string | null {
	switch (event.kind) {
		case "plan_approval":
			return resolvePlanApproval(registry, sessionId, event, action);
		case "ask":
			return resolveAsk(registry, sessionId, event, action);
		case "hook_selector":
			return resolveHookSelector(registry, sessionId, event, action);
		default:
			return null;
	}
}

export function registerSessionEventCallbacks(bot: TelegramBot, registry: SocketSessionRegistry | undefined): void {
	bot.callbackQuery(/^se:([^:]+):([^:]+):(.+)$/, async ctx => {
		await ctx.answerCallbackQuery();
		if (!registry) {
			await safeEditMessage(ctx, "Session bridge unavailable.");
			return;
		}

		const data = ctx.callbackQuery.data;
		const parsed = typeof data === "string" ? parseSessionEventCallbackData(data) : null;
		if (!parsed) {
			await safeEditMessage(ctx, "Invalid callback data.");
			return;
		}

		const session = registry
			.getActive()
			.find(activeSession => activeSession.sessionId.startsWith(parsed.sessionIdPrefix));
		if (!session) {
			await safeEditMessage(ctx, "Session not found or disconnected.");
			return;
		}

		const event = session.currentBlockingEvent;
		if (!event || !event.eventId.endsWith(parsed.eventIdSuffix)) {
			await safeEditMessage(ctx, "Event already handled.");
			return;
		}

		if (parsed.action === "dismiss") {
			registry.cancelEvent(session.sessionId, event.eventId, "Dismissed via Telegram");
			await safeEditMessage(ctx, "Dismissed.");
			return;
		}

		const result = resolveAction(registry, session.sessionId, event, parsed.action);
		if (!result) {
			await safeEditMessage(ctx, "Unhandled action.");
			return;
		}

		await safeEditMessage(ctx, result);
	});
}

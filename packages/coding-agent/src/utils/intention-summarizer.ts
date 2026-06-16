import { ThinkingLevel } from "@spell/pi-agent-core";
import type { Api, Model } from "@spell/pi-ai";
import { completeSimple } from "@spell/pi-ai";
import { logger } from "@spell/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveModelRoleValue } from "../config/model-resolver";
import { renderPromptTemplate } from "../config/prompt-templates";
import type { Settings } from "../config/settings";
import intentionSystemPrompt from "../prompts/system/intention-system.md" with { type: "text" };
import { toReasoningEffort } from "../thinking";

const INTENTION_SYSTEM_PROMPT = renderPromptTemplate(intentionSystemPrompt);

const MAX_FIRST_MESSAGE_CHARS = 2000;
const MAX_RECENT_TEXT_CHARS = 1500;
const MAX_TODO_TITLE_CHARS = 200;
const MAX_PLAN_SUMMARY_CHARS = 2000;

export interface BlockingEventLike {
	kind: "plan_approval" | "ask" | "pending_action" | "hook_selector" | "hook_input";
	eventId: string;
	/** Best-effort short title/question/description string for the event. */
	title?: string;
	/** For plan_approval — the full plan summary if available. */
	planSummary?: string;
}

export interface IntentionSummaryInput {
	firstUserMessage: string;
	/** Newest-last, recommended cap 3; longer is fine but the function will not slice further. */
	recentAssistantTexts: string[];
	blockingEvent?: BlockingEventLike;
	/** In-progress todo titles, recommended cap 5. */
	inProgressTodoTitles: string[];
	/** Optional steering signal — the session's generated title, if any. */
	sessionTitle?: string;
}

export interface IntentionSummaryResult {
	did: string;
	stuck?: string;
	ask: string;
}

function getIntentionModel(
	registry: ModelRegistry,
	settings: Settings,
	currentModel?: Model<Api>,
): { model: Model<Api>; thinkingLevel?: ThinkingLevel } | undefined {
	const availableModels = registry.getAvailable();
	if (availableModels.length === 0) return undefined;

	const matchPreferences = { usageOrder: settings.getStorage()?.getModelUsageOrder() };
	const configuredSmol = resolveModelRoleValue(settings.getModelRole("smol"), availableModels, {
		settings,
		matchPreferences,
	});
	if (configuredSmol.model) {
		return { model: configuredSmol.model, thinkingLevel: configuredSmol.thinkingLevel };
	}

	if (currentModel) {
		return { model: currentModel };
	}

	return undefined;
}

function truncate(str: string, max: number): string {
	if (str.length <= max) return str;
	return `${str.slice(0, max)}…`;
}

function isBlank(str: string | undefined): boolean {
	return !str || str.trim().length === 0;
}

function stripSurroundingQuotesAndTrailingPunctuation(value: string): string {
	return value.replace(/^["'`]+|["'`]+$/g, "").replace(/[.!?]+$/, "");
}

/** Exported for unit testing. Pure string→struct. */
export function parseIntentionSummaryResponse(text: string): IntentionSummaryResult | null {
	const lines = text.split("\n");
	let did = "";
	let stuck: string | undefined;
	let ask = "";
	let foundDid = false;
	let foundAsk = false;

	for (const line of lines) {
		const match = line.match(/^(DID|STUCK|ASK):\s*(.*)$/i);
		if (!match) continue;
		const [, key, value] = match;
		const trimmed = value.trim();
		switch (key.toUpperCase()) {
			case "DID":
				did = stripSurroundingQuotesAndTrailingPunctuation(trimmed);
				foundDid = true;
				break;
			case "STUCK":
				if (trimmed.length > 0) {
					stuck = stripSurroundingQuotesAndTrailingPunctuation(trimmed);
				}
				break;
			case "ASK":
				ask = stripSurroundingQuotesAndTrailingPunctuation(trimmed);
				foundAsk = true;
				break;
		}
	}

	if (!foundDid && !foundAsk) {
		return null;
	}

	return {
		did: foundDid ? did : "",
		ask: foundAsk ? ask : "",
		stuck,
	};
}

export async function generateIntentionSummary(
	input: IntentionSummaryInput,
	registry: ModelRegistry,
	settings: Settings,
	opts?: { sessionId?: string; currentModel?: Model<Api>; signal?: AbortSignal },
): Promise<IntentionSummaryResult | null> {
	const candidate = getIntentionModel(registry, settings, opts?.currentModel);
	if (!candidate) {
		logger.debug("intention-summarizer: no intention model found");
		return null;
	}

	if (opts?.signal?.aborted) {
		logger.debug("intention-summarizer: aborted before model call");
		return null;
	}

	const truncatedFirst = truncate(input.firstUserMessage, MAX_FIRST_MESSAGE_CHARS);
	const truncatedRecent = input.recentAssistantTexts.map(t => truncate(t, MAX_RECENT_TEXT_CHARS));
	const truncatedTodos = input.inProgressTodoTitles.map(t => truncate(t, MAX_TODO_TITLE_CHARS));

	const blocks: string[] = [];

	if (!isBlank(truncatedFirst)) {
		blocks.push(`<intent>\n${truncatedFirst}\n</intent>`);
	}

	for (const text of truncatedRecent) {
		if (!isBlank(text)) {
			blocks.push(`<recent>\n${text}\n</recent>`);
		}
	}

	if (input.blockingEvent) {
		const event = input.blockingEvent;
		let block = `<blocking kind="${event.kind}" eventId="${event.eventId}">`;
		if (event.title) {
			block += `\n${truncate(event.title, MAX_RECENT_TEXT_CHARS)}`;
		}
		if (event.planSummary) {
			block += `\n${truncate(event.planSummary, MAX_PLAN_SUMMARY_CHARS)}`;
		}
		block += "\n</blocking>";
		blocks.push(block);
	}

	const todoItems = truncatedTodos.filter(t => !isBlank(t));
	if (todoItems.length > 0) {
		blocks.push(`<todos>\n${todoItems.map(t => `- ${t}`).join("\n")}\n</todos>`);
	}

	if (!isBlank(input.sessionTitle)) {
		blocks.push(`<session-title>\n${input.sessionTitle}\n</session-title>`);
	}

	if (blocks.length === 0) {
		logger.debug("intention-summarizer: all inputs empty");
		return null;
	}

	const userMessage = blocks.join("\n\n");

	const apiKey = await registry.getApiKey(candidate.model, opts?.sessionId);
	if (!apiKey) {
		logger.debug("intention-summarizer: no API key for model", {
			provider: candidate.model.provider,
			id: candidate.model.id,
		});
		return null;
	}

	const request = {
		model: `${candidate.model.provider}/${candidate.model.id}`,
		systemPrompt: INTENTION_SYSTEM_PROMPT,
		userMessage,
		maxTokens: 120,
	};
	logger.debug("intention-summarizer: request", request);

	try {
		const response = await completeSimple(
			candidate.model,
			{
				systemPrompt: request.systemPrompt,
				messages: [{ role: "user", content: request.userMessage, timestamp: Date.now() }],
			},
			{
				apiKey,
				maxTokens: 120,
				reasoning: toReasoningEffort(candidate.thinkingLevel),
				disableReasoning: candidate.thinkingLevel === ThinkingLevel.Off,
				signal: opts?.signal,
			},
		);

		if (response.stopReason === "error") {
			logger.debug("intention-summarizer: response error", {
				model: request.model,
				stopReason: response.stopReason,
				errorMessage: response.errorMessage,
			});
			return null;
		}

		let text = "";
		for (const content of response.content) {
			if (content.type === "text") {
				text += content.text;
			}
		}
		text = text.trim();

		logger.debug("intention-summarizer: response", {
			model: request.model,
			text,
			usage: response.usage,
			stopReason: response.stopReason,
		});

		if (!text) {
			return null;
		}

		return parseIntentionSummaryResponse(text);
	} catch (err) {
		logger.debug("intention-summarizer: error", {
			model: request.model,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

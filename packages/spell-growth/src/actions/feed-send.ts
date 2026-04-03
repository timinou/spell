import * as path from "node:path";
import type { GrowthFeedActionInput } from "./types";

export interface GrowthFeedMessage {
	text: string;
	replyMarkup: {
		inlineKeyboard: Array<Array<{ text: string; callbackData: string }>>;
	};
}

export interface GrowthFeedActionResult {
	messages: GrowthFeedMessage[];
	artifactPath: string;
}

function buildMessageText(item: GrowthFeedActionInput["items"][number]): string {
	const personaLine = item.personaSlug ? `Persona: ${item.personaSlug}\n` : "";
	return `${item.title}\n${personaLine}${item.summary}\n${item.canonicalUrl}`;
}

export async function sendGrowthFeed(input: GrowthFeedActionInput): Promise<GrowthFeedActionResult> {
	const maxCharacters = input.maxCharacters ?? 4_000;
	const messages: GrowthFeedMessage[] = [];
	let currentText = "";
	let currentTargetItemId: string | null = null;
	for (const item of input.items) {
		const itemText = buildMessageText(item);
		const nextText = `${currentText}${currentText ? "\n\n" : ""}${itemText}`;
		if (nextText.length > maxCharacters && currentText) {
			messages.push({
				text: currentText,
				replyMarkup: {
					inlineKeyboard: [[{ text: "Approve publication", callbackData: `publish:${currentTargetItemId!}` }]],
				},
			});
			currentText = itemText.slice(0, maxCharacters);
			currentTargetItemId = item.id;
			continue;
		}
		currentText = nextText.slice(0, maxCharacters);
		currentTargetItemId = item.id;
	}
	if (currentText) {
		messages.push({
			text: currentText,
			replyMarkup: {
				inlineKeyboard: [[{ text: "Approve publication", callbackData: `publish:${currentTargetItemId!}` }]],
			},
		});
	}
	const artifactPath = path.join(input.outboxDir, "feed-digest.json");
	await Bun.write(artifactPath, JSON.stringify({ messages }, null, 2));
	return { messages, artifactPath };
}

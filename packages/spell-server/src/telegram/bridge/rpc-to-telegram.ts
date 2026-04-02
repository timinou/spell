import type { AssistantEvent, RpcAssistantMessage, RpcEvent } from "../../rpc/types";
import type { AuthContext } from "../bot/auth";
import { markdownToTelegramHtml } from "./markdown-html";
import { splitMessage } from "./message-splitter";

const DRAFT_INTERVAL_MS = 334;
const MAX_DRAFT_LENGTH = 4000;
const STREAM_DONE_TIMEOUT_MS = 5_000;

interface DraftApiRaw {
	sendMessageDraft?: (args: { chat_id: number; text: string }) => Promise<unknown>;
}

interface DraftCapableApi {
	raw?: DraftApiRaw;
}

async function sendDraft(ctx: AuthContext, chatId: number, text: string): Promise<void> {
	try {
		const rawApi = (ctx.api as unknown as DraftCapableApi).raw;
		if (!rawApi?.sendMessageDraft) {
			return;
		}
		await rawApi.sendMessageDraft({ chat_id: chatId, text });
	} catch {
		// Fallback: skip drafts and rely on final messages.
	}
}

function lastNonEmptyLine(text: string): string {
	const lines = text
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
	return lines.at(-1) ?? "";
}

function trimDraft(text: string): string {
	if (text.length <= MAX_DRAFT_LENGTH) {
		return text;
	}
	return text.slice(text.length - MAX_DRAFT_LENGTH);
}

function extractAssistantText(message: RpcAssistantMessage | undefined): string {
	if (!message?.content) {
		return "";
	}
	return message.content
		.filter(block => block.type === "text" && typeof block.text === "string")
		.map(block => block.text?.trim() ?? "")
		.filter(Boolean)
		.join("\n\n");
}

function mergeAssistantText(currentText: string, incomingText: string): string {
	const current = currentText.trim();
	const incoming = incomingText.trim();
	if (!current) {
		return incoming;
	}
	if (!incoming) {
		return current;
	}
	if (current === incoming) {
		return current;
	}
	if (incoming.startsWith(current)) {
		return incoming;
	}
	if (current.endsWith(incoming)) {
		return current;
	}
	const separator = current.endsWith(":") ? "\n\n" : " ";
	return `${current}${separator}${incoming}`;
}

function shouldFinalizeOnMessageEnd(message: RpcAssistantMessage | undefined): boolean {
	if (!message) {
		return true;
	}
	if (message.role && message.role !== "assistant") {
		return false;
	}
	return message.stopReason !== "toolUse";
}

export async function awaitStreamerCompletion(
	streamer: { done: Promise<void>; cancel: () => void },
	timeoutMs = STREAM_DONE_TIMEOUT_MS,
): Promise<void> {
	const completed = await Promise.race([streamer.done.then(() => true), Bun.sleep(timeoutMs).then(() => false)]);
	if (completed) {
		return;
	}
	streamer.cancel();
	await streamer.done;
}
export class ResponseStreamer {
	#ctx: AuthContext;
	#showThinking: boolean;
	#chatId: number | null;
	#text = "";
	#errorMessage = "";
	#thinking = "";
	#thinkingStatus = "";
	#toolStatus = "";
	#toolHistory: string[] = [];
	#lastDraft = "";
	#lastDraftAt = 0;
	#draftTimer: NodeJS.Timeout | null = null;
	#finalized = false;
	#doneResolve: () => void;
	#donePromise: Promise<void>;

	constructor(ctx: AuthContext, showThinking: boolean) {
		this.#ctx = ctx;
		this.#showThinking = showThinking;
		this.#chatId = this.#resolveChatId();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#donePromise = promise;
		this.#doneResolve = resolve;
	}

	async handleEvent(event: RpcEvent): Promise<void> {
		if (this.#finalized) {
			return;
		}

		switch (event.type) {
			case "message_update":
				await this.#handleAssistantEvent(event.assistantMessageEvent);
				return;
			case "tool_execution_start": {
				const detail = event.intent ? `${event.toolName} ${event.intent}` : event.toolName;
				this.#toolStatus = `Running: ${detail}`;
				this.#toolHistory.push(this.#toolStatus);
				await this.#scheduleDraftUpdate();
				return;
			}
			case "tool_execution_end": {
				const state = event.isError ? "Failed" : "Done";
				this.#toolStatus = `${state}: ${event.toolName}`;
				this.#toolHistory.push(this.#toolStatus);
				await this.#scheduleDraftUpdate();
				return;
			}
			case "error":
				this.#finalized = true;
				this.#clearDraftTimer();
				try {
					await this.#ctx.reply(`RPC error: ${event.message}`);
				} finally {
					this.#doneResolve();
				}
				return;
			case "response":
				if (!event.success) {
					this.#errorMessage = event.error;
					await this.#finalize();
				}
				return;
			case "message_end": {
				if (event.message?.role && event.message.role !== "assistant") {
					return;
				}
				const finalText = extractAssistantText(event.message);
				if (finalText) {
					this.#text = mergeAssistantText(this.#text, finalText);
				}
				if (event.message?.stopReason === "error" || event.message?.stopReason === "aborted") {
					this.#errorMessage =
						event.message.errorMessage ?? (this.#errorMessage || `Assistant ${event.message.stopReason}`);
					await this.#finalize();
					return;
				}
				if (shouldFinalizeOnMessageEnd(event.message)) {
					await this.#finalize();
				}
				return;
			}
			case "agent_end":
				await this.#finalize();
				return;
			default:
				return;
		}
	}

	get done(): Promise<void> {
		return this.#donePromise;
	}

	cancel(): void {
		if (this.#finalized) {
			return;
		}
		this.#finalized = true;
		this.#clearDraftTimer();
		this.#doneResolve();
	}

	#clearDraftTimer(): void {
		if (this.#draftTimer) {
			clearTimeout(this.#draftTimer);
			this.#draftTimer = null;
		}
	}

	#resolveChatId(): number | null {
		if (this.#ctx.chat && typeof this.#ctx.chat.id === "number") {
			return this.#ctx.chat.id;
		}
		const maybeMessage = this.#ctx.message as unknown as { chat?: { id?: number } } | undefined;
		if (maybeMessage?.chat && typeof maybeMessage.chat.id === "number") {
			return maybeMessage.chat.id;
		}
		return null;
	}

	async #handleAssistantEvent(event: AssistantEvent): Promise<void> {
		switch (event.type) {
			case "text_delta":
				this.#text += event.delta;
				await this.#scheduleDraftUpdate();
				return;
			case "text_end":
				this.#text = event.content;
				await this.#scheduleDraftUpdate();
				return;
			case "thinking_delta": {
				if (this.#showThinking) {
					this.#thinking += event.delta;
				}
				const source = this.#showThinking ? this.#thinking : event.delta;
				const line = lastNonEmptyLine(source);
				if (line) {
					this.#thinkingStatus = line;
					await this.#scheduleDraftUpdate();
				}
				return;
			}
			case "thinking_end":
				if (this.#showThinking) {
					this.#thinking = event.content;
				}
				this.#thinkingStatus = lastNonEmptyLine(event.content) || this.#thinkingStatus;
				await this.#scheduleDraftUpdate();
				return;
			case "error":
				this.#errorMessage =
					event.error?.errorMessage ?? (this.#errorMessage || `Assistant ${event.reason ?? "error"}`);
				await this.#scheduleDraftUpdate();
				return;
			default:
				return;
		}
	}

	#buildDraftText(): string {
		const parts: string[] = [];
		if (this.#toolStatus) {
			parts.push(this.#toolStatus);
		}
		if (this.#thinkingStatus) {
			parts.push(`Thinking: ${this.#thinkingStatus}`);
		}
		if (this.#text.trim()) {
			parts.push(this.#text.trim());
		}
		return trimDraft(parts.join("\n\n").trim());
	}

	async #scheduleDraftUpdate(): Promise<void> {
		if (!this.#chatId) {
			return;
		}
		const now = Date.now();
		const elapsed = now - this.#lastDraftAt;
		if (elapsed >= DRAFT_INTERVAL_MS) {
			await this.#flushDraft();
			return;
		}
		if (this.#draftTimer) {
			return;
		}
		this.#draftTimer = setTimeout(() => {
			this.#draftTimer = null;
			void this.#flushDraft();
		}, DRAFT_INTERVAL_MS - elapsed);
	}

	async #flushDraft(): Promise<void> {
		if (!this.#chatId) {
			return;
		}
		const draft = this.#buildDraftText();
		if (!draft || draft === this.#lastDraft) {
			return;
		}
		this.#lastDraft = draft;
		this.#lastDraftAt = Date.now();
		await sendDraft(this.#ctx, this.#chatId, draft);
	}

	#buildFinalMarkdown(): string {
		const text = this.#text.trim();
		if (text && this.#errorMessage) {
			return `${text}\n\nError: ${this.#errorMessage}`;
		}
		if (text) {
			return text;
		}
		if (this.#errorMessage) {
			return `Assistant error: ${this.#errorMessage}`;
		}
		if (this.#toolHistory.length > 0) {
			return `Assistant completed without a text response.\n\nTool activity:\n- ${this.#toolHistory.join("\n- ")}`;
		}
		if (this.#thinkingStatus) {
			return `Assistant completed without a text response.\n\nLast status: ${this.#thinkingStatus}`;
		}
		return "Assistant completed without a text response.";
	}

	async #finalize(): Promise<void> {
		if (this.#finalized) {
			return;
		}
		this.#finalized = true;
		this.#clearDraftTimer();

		try {
			const html = markdownToTelegramHtml(this.#buildFinalMarkdown());
			const messages = splitMessage(html || "Assistant completed without a text response.");
			for (const chunk of messages) {
				await this.#ctx.reply(chunk, { parse_mode: "HTML" });
			}
		} finally {
			this.#doneResolve();
		}
	}
}

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@spell/pi-utils";
import type { RpcEvent } from "../rpc/types";

function sanitizeTranscriptKey(chatId: string): string {
	const sanitized = chatId
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized || "chat";
}

function buildTranscriptPath(rootDir: string, chatId: string, createdAt: number): string {
	const timestamp = new Date(createdAt).toISOString().replace(/[:.]/g, "-");
	return path.join(rootDir, "transcripts", `${timestamp}_${sanitizeTranscriptKey(chatId)}.jsonl`);
}

export interface RpcTranscriptWriter {
	path: string;
	append(event: RpcEvent): void;
	flush(): Promise<void>;
}

class FileRpcTranscriptWriter implements RpcTranscriptWriter {
	#path: string;
	#pending: Promise<void> = Promise.resolve();

	constructor(pathValue: string) {
		this.#path = pathValue;
	}

	get path(): string {
		return this.#path;
	}

	async ensureFile(): Promise<void> {
		await fs.mkdir(path.dirname(this.#path), { recursive: true });
		await fs.appendFile(this.#path, "");
	}

	append(event: RpcEvent): void {
		const line = `${JSON.stringify(event)}\n`;
		this.#pending = this.#pending
			.then(() => fs.appendFile(this.#path, line))
			.catch(error => {
				logger.error("Failed to append Telegram transcript event", {
					transcriptPath: this.#path,
					error: String(error),
				});
			});
	}

	async flush(): Promise<void> {
		await this.#pending;
	}
}

export async function createRpcTranscriptWriter(
	rootDir: string,
	chatId: string,
	createdAt: number,
	restoredPath?: string,
): Promise<RpcTranscriptWriter> {
	const writer = new FileRpcTranscriptWriter(restoredPath ?? buildTranscriptPath(rootDir, chatId, createdAt));
	await writer.ensureFile();
	return writer;
}

// ---------------------------------------------------------------------------
// Session transcript renderer — newest-first markdown for needs_input notifications.
// Reference: /home/user/code/ora/spell-remote-example/bot/transcript.ts
// ---------------------------------------------------------------------------

interface TranscriptBlock {
	type: string;
	text?: string;
	name?: string;
	arguments?: unknown;
	content?: unknown;
	intent?: string;
}
interface TranscriptMessage {
	role?: string;
	content?: TranscriptBlock[] | string;
}
interface TranscriptLine {
	type?: string;
	message?: TranscriptMessage;
	timestamp?: string;
}

export interface RenderedTranscript {
	markdown: string;
	lastAssistantText: string;
	messageCount: number;
}

export type TranscriptScope = "full" | "last-turn" | { kind: "last-n"; n: number };

export interface RenderMarkdownOpts {
	scope?: TranscriptScope;
	maxToolBytes?: number;
	maxBytes?: number;
}

const DEFAULT_MAX_TOOL_BYTES = 800;
const DEFAULT_MAX_BYTES = 64 * 1024;

function clipText(s: string, n: number): string {
	if (s.length <= n) return s;
	return `${s.slice(0, n)}\n… (truncated, ${s.length - n} more chars)`;
}

function renderBlock(b: TranscriptBlock, maxToolBytes: number): string {
	if (b.type === "text" && typeof b.text === "string") return b.text.trim();
	if (b.type === "toolCall") {
		const args = typeof b.arguments === "object" ? JSON.stringify(b.arguments, null, 2) : String(b.arguments ?? "");
		const intent = b.intent ? ` _${b.intent}_` : "";
		return `\n> **tool** \`${b.name ?? "?"}\`${intent}\n\n\`\`\`json\n${clipText(args, maxToolBytes)}\n\`\`\``;
	}
	if (b.type === "toolResult") {
		const out = typeof b.content === "string" ? b.content : JSON.stringify(b.content, null, 2);
		return `\n> **tool result**\n\n\`\`\`\n${clipText(out, maxToolBytes)}\n\`\`\``;
	}
	return "";
}

function blocksOf(m: TranscriptMessage): TranscriptBlock[] {
	return Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }];
}

function applyScope(messages: TranscriptLine[], scope: TranscriptScope): TranscriptLine[] {
	if (scope === "full") return messages;
	if (scope === "last-turn") {
		let lastAssistant = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i]?.message?.role === "assistant") {
				lastAssistant = i;
				break;
			}
		}
		if (lastAssistant === -1) return messages.slice(-2);
		let precedingUser = -1;
		for (let i = lastAssistant - 1; i >= 0; i--) {
			if (messages[i]?.message?.role === "user") {
				precedingUser = i;
				break;
			}
		}
		return precedingUser >= 0
			? [messages[precedingUser] as TranscriptLine, messages[lastAssistant] as TranscriptLine]
			: [messages[lastAssistant] as TranscriptLine];
	}
	return messages.slice(-scope.n);
}

function chronologicalLastAssistantText(messages: TranscriptLine[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]?.message;
		if (!m || m.role !== "assistant") continue;
		const text = blocksOf(m)
			.filter(b => b.type === "text" && b.text)
			.map(b => b.text as string)
			.join("\n\n")
			.trim();
		if (text.length > 0) return text;
	}
	return "";
}

function renderMessages(messages: TranscriptLine[], maxToolBytes: number): string {
	const reversed = [...messages].reverse();
	const chunks: string[] = [];
	const total = reversed.length;
	for (let i = 0; i < reversed.length; i++) {
		const entry = reversed[i];
		if (!entry) continue;
		const m = entry.message;
		if (!m) continue;
		const role = m.role ?? "?";
		const body = blocksOf(m)
			.map(b => renderBlock(b, maxToolBytes))
			.filter(s => s.length > 0)
			.join("\n\n");
		if (body.length === 0) continue;
		const seq = total - i;
		const tag = i === 0 ? " — latest" : "";
		chunks.push(`## ${role} · #${seq}${tag}\n\n${body}`);
	}
	return chunks.join("\n\n---\n\n");
}

/**
 * Render a coding-agent JSONL session log to newest-first markdown for
 * Telegram needs_input notifications.
 *
 * - Latest exchange is the topmost rendered heading (marked ' — latest').
 * - Sequence numbers count from oldest (#1) up.
 * - `lastAssistantText` is pulled from the chronological last assistant turn.
 * - Token budget shrinks tool payloads first, then drops oldest messages.
 */
export async function renderSessionMarkdown(
	jsonlPath: string,
	opts: RenderMarkdownOpts = {},
): Promise<RenderedTranscript> {
	const maxToolBytes = opts.maxToolBytes ?? DEFAULT_MAX_TOOL_BYTES;
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
	const scope: TranscriptScope = opts.scope ?? "full";

	let raw: string;
	try {
		raw = await fs.readFile(jsonlPath, "utf-8");
	} catch (error) {
		logger.warn("transcript-store: failed to read JSONL", { jsonlPath, error: String(error) });
		return { markdown: "", lastAssistantText: "", messageCount: 0 };
	}

	const lines = raw.split("\n").filter(l => l.trim().length > 0);
	const parsed: TranscriptLine[] = [];
	let malformed = 0;
	for (const l of lines) {
		try {
			parsed.push(JSON.parse(l) as TranscriptLine);
		} catch {
			malformed += 1;
		}
	}
	if (malformed > 0) {
		logger.warn("transcript-store: skipped malformed JSONL lines", { jsonlPath, count: malformed });
	}
	const messages = parsed.filter(p => p.type === "message" && p.message);
	const scoped = applyScope(messages, scope);
	const lastAssistantText = chronologicalLastAssistantText(messages);

	let markdown = renderMessages(scoped, maxToolBytes);

	if (markdown.length > maxBytes) {
		const tighter = renderMessages(scoped, Math.min(maxToolBytes, 200));
		markdown = tighter;
	}
	if (markdown.length > maxBytes) {
		let kept = scoped.slice(-Math.max(1, Math.floor(scoped.length / 2)));
		while (kept.length > 1 && renderMessages(kept, 200).length > maxBytes) {
			kept = kept.slice(-Math.max(1, Math.floor(kept.length / 2)));
		}
		markdown = renderMessages(kept, 200);
	}

	return { markdown, lastAssistantText, messageCount: messages.length };
}

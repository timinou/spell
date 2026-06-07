import { logger } from "@spell/pi-utils";
import type { EventLogEntry } from "../../socket/types";

/**
 * Bounds for a single transcript backfill. Tuned so a freshly-opened web
 * session shows meaningful recent context without flooding the socket or
 * re-streaming an entire long-running session.
 */
export interface TranscriptReplayBounds {
	/** Maximum number of rendered entries to return (the most recent N). */
	maxEntries: number;
	/** Maximum bytes of raw JSONL to scan from the tail of the file. */
	maxBytes: number;
}

export const DEFAULT_TRANSCRIPT_REPLAY_BOUNDS: TranscriptReplayBounds = {
	maxEntries: 200,
	maxBytes: 1_000_000,
};

// ---------------------------------------------------------------------------
// Minimal structural mirror of the coding-agent session JSONL.
//
// spell-server intentionally does NOT depend on @spell/coding-agent, so we
// parse only the narrow shape needed to reconstruct an EventLogEntry stream.
// Unknown entry types and malformed lines are skipped truthfully.
// ---------------------------------------------------------------------------

interface RawMessage {
	role?: string;
	content?: string | unknown[];
	toolName?: string;
	isError?: boolean;
	attribution?: string;
	timestamp?: number;
}

interface RawMessageEntry {
	type: "message";
	message?: RawMessage;
	timestamp?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Pull joined text from a message content (string or text blocks). */
function extractText(content: RawMessage["content"]): string | undefined {
	if (typeof content === "string") {
		const trimmed = content.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
			parts.push(block.text.trim());
		}
	}
	const joined = parts.join("\n").trim();
	return joined.length > 0 ? joined : undefined;
}

/** Resolve a millisecond ts from the entry, falling back to the JSONL header timestamp. */
function resolveTs(entry: RawMessageEntry): number {
	const fromMessage = entry.message?.timestamp;
	if (typeof fromMessage === "number" && Number.isFinite(fromMessage)) return fromMessage;
	if (typeof entry.timestamp === "string") {
		const parsed = Date.parse(entry.timestamp);
		if (Number.isFinite(parsed)) return parsed;
	}
	return Date.now();
}

/**
 * Map a single session `message` entry to zero or one EventLogEntry. Tool
 * calls inside an assistant message surface as `tool_call` summaries; plain
 * text surfaces as `assistant_text` / `user_message`. Thinking, images, and
 * tool-result plumbing are intentionally dropped from the lightweight feed.
 */
/**
 * Map a single session `message` entry to zero or more EventLogEntry. Plain
 * text surfaces as `assistant_text` / `user_message`; assistant tool calls
 * surface as ordered `tool_call` summaries after any leading text. Thinking,
 * images, and tool-result content blocks are intentionally dropped from the
 * lightweight feed.
 */
function mapMessageEntry(entry: RawMessageEntry): EventLogEntry[] {
	const message = entry.message;
	if (!message || typeof message.role !== "string") return [];
	const ts = resolveTs(entry);

	switch (message.role) {
		case "user":
		case "developer": {
			// Mirror the live emitter: only real user turns become user_message.
			if (message.role === "user" && message.attribution !== undefined && message.attribution !== "user") {
				return [];
			}
			const text = extractText(message.content);
			return text ? [{ kind: "user_message", ts, text }] : [];
		}
		case "assistant": {
			const out: EventLogEntry[] = [];
			const text = extractText(message.content);
			if (text) out.push({ kind: "assistant_text", ts, text });
			if (Array.isArray(message.content)) {
				for (const block of message.content) {
					if (isRecord(block) && block.type === "toolCall" && typeof block.name === "string") {
						const intent = typeof block.intent === "string" ? block.intent : undefined;
						out.push({ kind: "tool_call", ts, toolName: block.name, text: intent });
					}
				}
			}
			return out;
		}
		case "toolResult": {
			if (typeof message.toolName !== "string") return [];
			return [
				{
					kind: "tool_result",
					ts,
					toolName: message.toolName,
					meta: message.isError ? { isError: true } : undefined,
				},
			];
		}
		default:
			return [];
	}
}

/**
 * Read the tail of a session JSONL file and reconstruct the most recent
 * transcript as an ordered EventLogEntry[] for web backfill.
 *
 * - Bounded by both byte budget (tail scan) and entry count (most recent N).
 * - Tolerates a trailing partial line (file mid-write) and malformed lines.
 * - Returns [] for a missing/empty/header-less file — never throws across the
 *   ws dispatch boundary.
 */
export async function replayTranscript(
	transcriptPath: string,
	bounds: TranscriptReplayBounds = DEFAULT_TRANSCRIPT_REPLAY_BOUNDS,
): Promise<EventLogEntry[]> {
	let raw: string;
	try {
		const file = Bun.file(transcriptPath);
		const size = file.size;
		if (!Number.isFinite(size) || size === 0) return [];
		// Scan only the tail within the byte budget.
		const slice = size > bounds.maxBytes ? file.slice(size - bounds.maxBytes) : file;
		raw = await slice.text();
	} catch (err) {
		logger.debug("transcript replay: read failed", {
			transcriptPath,
			error: err instanceof Error ? err.message : String(err),
		});
		return [];
	}

	const lines = raw.split("\n");
	const out: EventLogEntry[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			// Partial/truncated tail line or corruption — skip truthfully.
			continue;
		}
		if (!isRecord(parsed) || parsed.type !== "message") continue;
		for (const mapped of mapMessageEntry(parsed as unknown as RawMessageEntry)) out.push(mapped);
	}

	// Keep only the most recent N, preserving chronological order.
	return out.length > bounds.maxEntries ? out.slice(out.length - bounds.maxEntries) : out;
}

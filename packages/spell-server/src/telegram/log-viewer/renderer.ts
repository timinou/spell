import { parseJsonlLenient } from "@oh-my-pi/pi-utils";
import type { ChatSession } from "../../rpc/bridge-types";
import { summarizeToolPartialResult } from "../tool-progress";
import { escapeHtmlAttr } from "../utils";

type ToolStatus = "running" | "done" | "error";

type ToolTimelineEntry = {
	kind: "tool";
	toolName: string;
	toolCallId: string;
	status: ToolStatus;
	details: string[];
};

type TimelineEntry =
	| { kind: "user"; text: string }
	| { kind: "assistant"; text: string }
	| { kind: "thinking"; text: string }
	| ToolTimelineEntry;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function extractTextParts(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const textParts: string[] = [];
	for (const part of value) {
		if (!isRecord(part) || typeof part.text !== "string") {
			continue;
		}
		textParts.push(part.text);
	}
	return textParts;
}

function extractMessageText(event: Record<string, unknown>): string {
	const message = isRecord(event.message) ? event.message : undefined;
	if (!message) {
		return "";
	}

	if (typeof message.text === "string") {
		return message.text;
	}
	if (typeof message.content === "string") {
		return message.content;
	}
	return extractTextParts(message.content).join("\n");
}

function appendUniqueDetail(entry: ToolTimelineEntry, detail: string): void {
	const trimmed = detail.trim();
	if (!trimmed || entry.details.at(-1) === trimmed) {
		return;
	}
	entry.details.push(trimmed);
}

function getToolEntry(
	entries: TimelineEntry[],
	toolById: Map<string, number>,
	toolCallId: string,
	toolName: string,
): ToolTimelineEntry {
	const index = toolById.get(toolCallId);
	const existing = index === undefined ? undefined : entries[index];
	if (existing?.kind === "tool") {
		existing.toolName = toolName;
		return existing;
	}

	const entry: ToolTimelineEntry = {
		kind: "tool",
		toolName,
		toolCallId,
		status: "running",
		details: [],
	};
	entries.push(entry);
	toolById.set(toolCallId, entries.length - 1);
	return entry;
}

function parseTimeline(jsonlContent: string): TimelineEntry[] {
	const entries: TimelineEntry[] = [];
	const toolById = new Map<string, number>();
	let assistantBuffer = "";
	let thinkingBuffer = "";

	const flushAssistant = () => {
		const trimmed = assistantBuffer.trim();
		if (!trimmed) {
			assistantBuffer = "";
			return;
		}
		entries.push({ kind: "assistant", text: trimmed });
		assistantBuffer = "";
	};

	const flushThinking = () => {
		const trimmed = thinkingBuffer.trim();
		if (!trimmed) {
			thinkingBuffer = "";
			return;
		}
		entries.push({ kind: "thinking", text: trimmed });
		thinkingBuffer = "";
	};

	for (const parsed of parseJsonlLenient<Record<string, unknown>>(jsonlContent)) {
		if (typeof parsed.type !== "string") {
			continue;
		}

		switch (parsed.type) {
			case "message_start": {
				const message = isRecord(parsed.message) ? parsed.message : undefined;
				if (message?.role === "user") {
					flushThinking();
					flushAssistant();
					const text = extractMessageText(parsed);
					entries.push({ kind: "user", text: text || "(user message)" });
				}
				break;
			}
			case "message_update": {
				const assistantEvent = isRecord(parsed.assistantMessageEvent) ? parsed.assistantMessageEvent : undefined;
				if (!assistantEvent || typeof assistantEvent.type !== "string") {
					break;
				}
				if (assistantEvent.type === "text_delta" && typeof assistantEvent.delta === "string") {
					assistantBuffer += assistantEvent.delta;
					break;
				}
				if (assistantEvent.type === "text_end" && typeof assistantEvent.content === "string") {
					assistantBuffer = assistantEvent.content;
					flushAssistant();
					break;
				}
				if (assistantEvent.type === "thinking_delta" && typeof assistantEvent.delta === "string") {
					thinkingBuffer += assistantEvent.delta;
					break;
				}
				if (assistantEvent.type === "thinking_end" && typeof assistantEvent.content === "string") {
					thinkingBuffer = assistantEvent.content;
					flushThinking();
				}
				break;
			}
			case "message_end": {
				flushThinking();
				flushAssistant();
				break;
			}
			case "tool_execution_start": {
				flushThinking();
				flushAssistant();
				const toolCallId = typeof parsed.toolCallId === "string" ? parsed.toolCallId : `tool-${entries.length}`;
				const toolName = typeof parsed.toolName === "string" ? parsed.toolName : "unknown";
				const entry = getToolEntry(entries, toolById, toolCallId, toolName);
				entry.status = "running";
				if (typeof parsed.intent === "string" && parsed.intent.trim()) {
					appendUniqueDetail(entry, `intent: ${parsed.intent}`);
				}
				break;
			}
			case "tool_execution_update": {
				flushThinking();
				flushAssistant();
				const toolCallId = typeof parsed.toolCallId === "string" ? parsed.toolCallId : `tool-${entries.length}`;
				const toolName = typeof parsed.toolName === "string" ? parsed.toolName : "unknown";
				const entry = getToolEntry(entries, toolById, toolCallId, toolName);
				entry.status = "running";
				appendUniqueDetail(entry, summarizeToolPartialResult(parsed.partialResult));
				break;
			}
			case "tool_execution_end": {
				flushThinking();
				flushAssistant();
				const toolCallId = typeof parsed.toolCallId === "string" ? parsed.toolCallId : `tool-${entries.length}`;
				const toolName = typeof parsed.toolName === "string" ? parsed.toolName : "unknown";
				const entry = getToolEntry(entries, toolById, toolCallId, toolName);
				entry.status = parsed.isError ? "error" : "done";
				appendUniqueDetail(entry, summarizeToolPartialResult(parsed.result));
				appendUniqueDetail(entry, entry.status === "error" ? "result: failed" : "result: ok");
				break;
			}
			default:
				break;
		}
	}

	flushThinking();
	flushAssistant();
	return entries;
}

function renderTimelineEntry(entry: TimelineEntry): string {
	if (entry.kind === "user") {
		return `<div class="bubble user"><div class="label">User</div><pre>${escapeHtmlAttr(entry.text)}</pre></div>`;
	}

	if (entry.kind === "assistant") {
		return `<div class="bubble assistant"><div class="label">Assistant</div><pre>${escapeHtmlAttr(entry.text)}</pre></div>`;
	}

	if (entry.kind === "thinking") {
		return `<div class="bubble thinking"><div class="label">Thinking</div><pre>${escapeHtmlAttr(entry.text)}</pre></div>`;
	}

	const statusLabel = entry.status === "error" ? "error" : entry.status === "done" ? "done" : "running";
	const detailText = entry.details.length > 0 ? entry.details.join("\n") : "(no details)";
	return [
		`<details class="tool ${entry.status}">`,
		`<summary>Tool ${escapeHtmlAttr(entry.toolName)} (${escapeHtmlAttr(entry.toolCallId)}) - ${statusLabel}</summary>`,
		`<pre>${escapeHtmlAttr(detailText)}</pre>`,
		`</details>`,
	].join("");
}

/** Render a single session JSONL stream as an HTML transcript. */
export function renderSessionHtml(jsonlContent: string): string {
	const entries = parseTimeline(jsonlContent);
	const body =
		entries.length === 0
			? `<p class="empty">no messages yet</p>`
			: entries.map(entry => renderTimelineEntry(entry)).join("\n");

	return `<!doctype html>
<html>
<head>
	<meta charset="utf-8" />
	<title>Spell Session Transcript</title>
	<style>
		:root { color-scheme: dark; }
		body { margin: 0; padding: 24px; font-family: Inter, system-ui, sans-serif; background: #0f1115; color: #e5e7eb; }
		main { max-width: 900px; margin: 0 auto; display: flex; flex-direction: column; gap: 12px; }
		.bubble { border-radius: 12px; padding: 12px; border: 1px solid #374151; }
		.bubble.user { background: #1f2937; }
		.bubble.assistant { background: #111827; }
		.bubble.thinking { background: #16101f; border-color: #6d28d9; }
		.label { font-size: 0.8rem; color: #93c5fd; margin-bottom: 6px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
		pre { white-space: pre-wrap; margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; line-height: 1.4; }
		details.tool { border: 1px solid #4b5563; border-radius: 8px; padding: 10px 12px; background: #111827; }
		details.tool.done summary { color: #86efac; }
		details.tool.error summary { color: #fca5a5; }
		.empty { color: #9ca3af; font-style: italic; }
		a { color: #93c5fd; }
	</style>
</head>
<body>
	<main>
		<h1>Session Transcript</h1>
		${body}
		<p><a href="/">Back to sessions</a></p>
	</main>
</body>
</html>`;
}

function formatTimestamp(value: number): string {
	if (!Number.isFinite(value)) {
		return "-";
	}
	return new Date(value).toISOString();
}

/** Render active session list for the index page. */
export function renderSessionListHtml(sessions: ChatSession[]): string {
	const sorted = [...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
	const rows =
		sorted.length === 0
			? `<tr><td colspan="4" class="empty">No active sessions</td></tr>`
			: sorted
					.map(session => {
						const chatId = encodeURIComponent(session.chatId);
						return `<tr>
							<td>${escapeHtmlAttr(session.chatId)}</td>
							<td>${escapeHtmlAttr(session.project)}</td>
							<td>${escapeHtmlAttr(formatTimestamp(session.lastActiveAt))}</td>
							<td><a href="/session/${chatId}">view</a> · <a href="/session/${chatId}/raw">raw</a></td>
						</tr>`;
					})
					.join("\n");

	return `<!doctype html>
<html>
<head>
	<meta charset="utf-8" />
	<title>Spell Telegram Sessions</title>
	<style>
		:root { color-scheme: dark; }
		body { margin: 0; padding: 24px; font-family: Inter, system-ui, sans-serif; background: #0f1115; color: #e5e7eb; }
		main { max-width: 960px; margin: 0 auto; }
		table { width: 100%; border-collapse: collapse; margin-top: 16px; }
		th, td { padding: 10px; border-bottom: 1px solid #374151; text-align: left; }
		th { color: #9ca3af; text-transform: uppercase; font-size: 0.78rem; letter-spacing: 0.04em; }
		tr:hover { background: #111827; }
		a { color: #93c5fd; }
		.empty { color: #9ca3af; font-style: italic; text-align: center; }
	</style>
</head>
<body>
	<main>
		<h1>Active Telegram Sessions</h1>
		<table>
			<thead>
				<tr>
					<th>Chat ID</th>
					<th>Project</th>
					<th>Last Active</th>
					<th>Actions</th>
				</tr>
			</thead>
			<tbody>
				${rows}
			</tbody>
		</table>
	</main>
</body>
</html>`;
}

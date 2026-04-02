import type { ChatSession } from "../types";
import { escapeHtmlAttr } from "../utils";

type ToolStatus = "running" | "done" | "error";

type ToolTimelineEntry = {
	kind: "tool";
	toolName: string;
	toolCallId: string;
	status: ToolStatus;
	details: string[];
};

type TimelineEntry = { kind: "user"; text: string } | { kind: "assistant"; text: string } | ToolTimelineEntry;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function extractUserText(event: Record<string, unknown>): string {
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

	if (!Array.isArray(message.content)) {
		return "";
	}

	const textParts: string[] = [];
	for (const part of message.content) {
		if (!isRecord(part)) {
			continue;
		}
		if (typeof part.text === "string") {
			textParts.push(part.text);
		}
	}

	return textParts.join("\n");
}

function parseTimeline(jsonlContent: string): TimelineEntry[] {
	const entries: TimelineEntry[] = [];
	const toolById = new Map<string, number>();
	let assistantBuffer = "";

	const flushAssistant = () => {
		const trimmed = assistantBuffer.trim();
		if (!trimmed) {
			assistantBuffer = "";
			return;
		}
		entries.push({ kind: "assistant", text: trimmed });
		assistantBuffer = "";
	};

	for (const rawLine of jsonlContent.split("\n")) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}

		if (!isRecord(parsed) || typeof parsed.type !== "string") {
			continue;
		}

		switch (parsed.type) {
			case "message_start": {
				const message = isRecord(parsed.message) ? parsed.message : undefined;
				if (message?.role === "user") {
					flushAssistant();
					const text = extractUserText(parsed);
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
				}
				break;
			}
			case "message_end": {
				flushAssistant();
				break;
			}
			case "tool_execution_start": {
				flushAssistant();
				const toolCallId = typeof parsed.toolCallId === "string" ? parsed.toolCallId : `tool-${entries.length}`;
				const toolName = typeof parsed.toolName === "string" ? parsed.toolName : "unknown";
				const details: string[] = [];
				if (typeof parsed.intent === "string" && parsed.intent.trim()) {
					details.push(`intent: ${parsed.intent}`);
				}
				entries.push({
					kind: "tool",
					toolName,
					toolCallId,
					status: "running",
					details,
				});
				toolById.set(toolCallId, entries.length - 1);
				break;
			}
			case "tool_execution_end": {
				flushAssistant();
				const toolCallId = typeof parsed.toolCallId === "string" ? parsed.toolCallId : "unknown";
				const toolName = typeof parsed.toolName === "string" ? parsed.toolName : "unknown";
				const status: ToolStatus = parsed.isError ? "error" : "done";
				const index = toolById.get(toolCallId);
				if (index === undefined) {
					entries.push({
						kind: "tool",
						toolName,
						toolCallId,
						status,
						details: [],
					});
					break;
				}
				const existing = entries[index];
				if (existing?.kind === "tool") {
					existing.status = status;
					existing.details.push(status === "error" ? "result: failed" : "result: ok");
				}
				break;
			}
			default:
				break;
		}
	}

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

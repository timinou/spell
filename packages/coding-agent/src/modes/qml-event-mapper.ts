import type { AgentSessionEvent } from "../session/agent-session";

/** Narrow to messages that carry a standard content array (excludes custom messages like BashExecutionMessage). */
function hasContent(msg: unknown): msg is { role: string; content: ReadonlyArray<{ type: string }> } {
	return (
		typeof msg === "object" &&
		msg !== null &&
		"content" in msg &&
		Array.isArray((msg as Record<string, unknown>).content)
	);
}

function getRoleIfPresent(msg: unknown): string | undefined {
	if (typeof msg === "object" && msg !== null && "role" in msg) {
		return (msg as { role: string }).role;
	}
	return undefined;
}

/** Extract concatenated text content from a message's content array. */
function getMessageText(content: ReadonlyArray<{ type: string; text?: string }>): string {
	return content
		.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
		.map(c => c.text)
		.join("");
}

/** Extract concatenated thinking content from a message's content array. */
function getThinkingText(content: ReadonlyArray<{ type: string; thinking?: string }>): string {
	return content
		.filter(
			(c): c is { type: "thinking"; thinking: string } => c.type === "thinking" && typeof c.thinking === "string",
		)
		.map(c => c.thinking)
		.join("");
}

/**
 * Maps AgentSessionEvents to simplified QML payloads.
 * Each instance holds its own state, making it safe to use per-session
 * and safe to test in isolation.
 */
export class SessionEventMapper {
	#messageCounter = 0;
	#currentMessageId = "";
	#lastTextLength = 0;

	map(event: AgentSessionEvent): Record<string, unknown> | null {
		switch (event.type) {
			case "message_start":
				this.#currentMessageId = `msg-${++this.#messageCounter}`;
				this.#lastTextLength = 0;
				return { type: "message_start", id: this.#currentMessageId, role: getRoleIfPresent(event.message) };
			case "message_update": {
				const msg = event.message;
				if (!hasContent(msg)) return null;
				const fullText = getMessageText(msg.content);
				const delta = fullText.slice(this.#lastTextLength);
				this.#lastTextLength = fullText.length;
				if (!delta && !getThinkingText(msg.content)) return null;
				return {
					type: "message_update",
					id: this.#currentMessageId,
					role: msg.role,
					text: delta,
					thinking: getThinkingText(msg.content),
				};
			}
			case "message_end":
				return { type: "message_end", id: this.#currentMessageId, role: getRoleIfPresent(event.message) };
			case "tool_execution_start":
				return {
					type: "tool_start",
					id: event.toolCallId,
					name: event.toolName,
					details: event.intent,
				};
			case "tool_execution_update":
				return {
					type: "tool_update",
					id: event.toolCallId,
					name: event.toolName,
				};
			case "tool_execution_end":
				return {
					type: "tool_end",
					id: event.toolCallId,
					name: event.toolName,
					isError: event.isError,
				};
			case "agent_start":
				return { type: "agent_busy", busy: true };
			case "agent_end":
				return { type: "agent_busy", busy: false };
			default:
				return null;
		}
	}
}

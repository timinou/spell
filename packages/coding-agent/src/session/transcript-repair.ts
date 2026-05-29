import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";

/**
 * Repair a loaded transcript so every assistant `toolCall` has a matching
 * `toolResult`.
 *
 * A hard process kill mid-tool-execution (reboot / crash / SIGKILL / OOM)
 * writes the assistant `toolCall` line to the session JSONL but dies before the
 * `toolResult` line. The in-process abort backfill (`createAbortedToolResult`
 * in the agent loop) only fires when the *running* process observes the abort,
 * so a hard kill leaves the pair permanently broken on disk. On resume this
 * violates the model API's tool_use/tool_result pairing invariant and renders
 * phantom-pending UI cells.
 *
 * This pass scans the loaded messages and inserts a synthetic terminal
 * (error) `toolResult` immediately after the assistant message for any of its
 * `toolCall`s that has no `toolResult` anywhere in the transcript. A result
 * present anywhere later (including async "running" results) counts as paired
 * and is left untouched.
 *
 * Pure: returns a new array; the input is not mutated.
 */
export const INTERRUPTED_TRANSCRIPT_RESULT_TEXT =
	"Tool execution interrupted; no result recorded (session ended before completion).";

export function repairUnpairedToolCalls(messages: AgentMessage[]): {
	messages: AgentMessage[];
	repaired: number;
} {
	// Every toolCallId that already has a result somewhere in the transcript.
	const resolved = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult") {
			resolved.add(message.toolCallId);
		}
	}

	const out: AgentMessage[] = [];
	let repaired = 0;

	for (const message of messages) {
		out.push(message);
		if (message.role !== "assistant") continue;

		const assistant = message as AssistantMessage;
		for (const block of assistant.content) {
			if (block.type !== "toolCall") continue;
			if (resolved.has(block.id)) continue;

			out.push(syntheticAbortedResult(block.id, block.name));
			resolved.add(block.id); // guard against duplicate toolCall ids
			repaired++;
		}
	}

	return { messages: out, repaired };
}

function syntheticAbortedResult(toolCallId: string, toolName: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: INTERRUPTED_TRANSCRIPT_RESULT_TEXT }],
		details: {},
		isError: true,
		timestamp: Date.now(),
	};
}

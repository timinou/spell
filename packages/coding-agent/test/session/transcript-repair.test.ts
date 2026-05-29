import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { repairUnpairedToolCalls } from "../../src/session/transcript-repair";

function assistantWithToolCalls(...ids: string[]): AssistantMessage {
	return {
		role: "assistant",
		content: ids.map(id => ({ type: "toolCall", id, name: "bash", arguments: {} })),
	} as AssistantMessage;
}

function toolResult(toolCallId: string, toolName = "bash"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		details: {},
		isError: false,
		timestamp: 1,
	};
}

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }] } as AgentMessage;
}

describe("repairUnpairedToolCalls", () => {
	test("inserts a synthetic toolResult for an unpaired toolCall", () => {
		const messages: AgentMessage[] = [assistantWithToolCalls("A"), user("retry; my computer had to reboot")];

		const { messages: out, repaired } = repairUnpairedToolCalls(messages);

		expect(repaired).toBe(1);
		// Synthetic result must directly follow the assistant message that declared A.
		expect(out[0].role).toBe("assistant");
		expect(out[1].role).toBe("toolResult");
		expect((out[1] as ToolResultMessage).toolCallId).toBe("A");
		expect((out[1] as ToolResultMessage).isError).toBe(true);
		expect(out[2].role).toBe("user");
	});

	test("is a no-op when every toolCall already has a result", () => {
		const messages: AgentMessage[] = [assistantWithToolCalls("A"), toolResult("A"), user("next")];

		const { messages: out, repaired } = repairUnpairedToolCalls(messages);

		expect(repaired).toBe(0);
		expect(out).toHaveLength(3);
		expect(out.map(m => m.role)).toEqual(["assistant", "toolResult", "user"]);
	});

	test("repairs each unpaired call in a multi-call assistant message, preserving paired ones", () => {
		const messages: AgentMessage[] = [
			assistantWithToolCalls("A", "B", "C"),
			toolResult("B"), // only B resolved
			user("next"),
		];

		const { messages: out, repaired } = repairUnpairedToolCalls(messages);

		expect(repaired).toBe(2);
		// All three toolCalls now have a toolResult.
		const resultIds = out
			.filter((m): m is ToolResultMessage => m.role === "toolResult")
			.map(m => m.toolCallId)
			.sort();
		expect(resultIds).toEqual(["A", "B", "C"]);
		// Synthetic results sit immediately after the assistant message.
		expect(out[0].role).toBe("assistant");
		expect(out[1].role).toBe("toolResult");
		expect(out[2].role).toBe("toolResult");
	});

	test("matches a result anywhere later, not only immediately after", () => {
		// Even if the persisted result is not adjacent, presence means no repair.
		const messages: AgentMessage[] = [assistantWithToolCalls("A"), user("interjection"), toolResult("A")];

		const { repaired } = repairUnpairedToolCalls(messages);

		expect(repaired).toBe(0);
	});

	test("preserves toolName on the synthetic result", () => {
		const a: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "A", name: "edit", arguments: {} }],
		} as AssistantMessage;

		const { messages: out } = repairUnpairedToolCalls([a]);

		const synthetic = out.find((m): m is ToolResultMessage => m.role === "toolResult");
		expect(synthetic?.toolName).toBe("edit");
		expect(synthetic?.isError).toBe(true);
	});

	test("does not mutate the input array", () => {
		const messages: AgentMessage[] = [assistantWithToolCalls("A")];
		const before = messages.length;

		repairUnpairedToolCalls(messages);

		expect(messages).toHaveLength(before);
	});
});

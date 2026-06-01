import { describe, expect, it } from "bun:test";
import type { Message, ToolResultMessage } from "@spell/pi-ai";
import {
	buildIntentionSummaryContent,
	hoistInterleavedToolResults,
	INTENTION_SUMMARY_MESSAGE_TYPE,
	type IntentionSummaryDetails,
} from "@spell/pi-coding-agent/session/messages";

// Minimal Message factories for pairing-invariant tests.
function toolResult(id: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "bash",
		content: [{ type: "text", text: `result ${id}` }],
		isError: false,
		timestamp: 0,
	};
}
function userMsg(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 } as Message;
}
function assistantMsg(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {} as never,
		stopReason: "endTurn",
		timestamp: 0,
	} as unknown as Message;
}
const ids = (ms: Message[]): string[] =>
	ms.map(m =>
		m.role === "toolResult" ? `R:${m.toolCallId}` : m.role === "user" ? `U` : m.role === "assistant" ? `A` : m.role,
	);

describe("hoistInterleavedToolResults", () => {
	it("hoists a non-result message spliced inside a tool_result run to after the run", () => {
		// Reproduces the intentionSummary-on-needs_input corruption: a custom/user
		// message is persisted between tool_result #1 and #2 of one batch.
		const input: Message[] = [
			assistantMsg("batch"),
			toolResult("a"),
			userMsg("intention summary"),
			toolResult("b"),
			toolResult("c"),
			assistantMsg("next"),
		];
		expect(ids(hoistInterleavedToolResults(input))).toEqual(["A", "R:a", "R:b", "R:c", "U", "A"]);
	});

	it("leaves a message that legitimately trails a completed run untouched", () => {
		const input: Message[] = [assistantMsg("batch"), toolResult("a"), toolResult("b"), userMsg("follow up")];
		expect(ids(hoistInterleavedToolResults(input))).toEqual(["A", "R:a", "R:b", "U"]);
	});

	it("hoists multiple interleaved messages preserving their relative order", () => {
		const input: Message[] = [toolResult("a"), userMsg("one"), toolResult("b"), userMsg("two"), toolResult("c")];
		const out = hoistInterleavedToolResults(input);
		expect(ids(out)).toEqual(["R:a", "R:b", "R:c", "U", "U"]);
		expect((out[3] as Message & { content: { text: string }[] }).content[0].text).toBe("one");
		expect((out[4] as Message & { content: { text: string }[] }).content[0].text).toBe("two");
	});

	it("is a no-op for well-formed transcripts", () => {
		const input: Message[] = [assistantMsg("a"), toolResult("a"), assistantMsg("b"), userMsg("hi")];
		expect(hoistInterleavedToolResults(input)).toEqual(input);
	});

	it("handles a run ending at end-of-list with a trailing non-result", () => {
		const input: Message[] = [toolResult("a"), toolResult("b"), userMsg("tail")];
		expect(ids(hoistInterleavedToolResults(input))).toEqual(["R:a", "R:b", "U"]);
	});
});

describe("INTENTION_SUMMARY_MESSAGE_TYPE", () => {
	it("has the expected string value (on-disk stable)", () => {
		expect(INTENTION_SUMMARY_MESSAGE_TYPE).toBe("intentionSummary");
	});
});

describe("buildIntentionSummaryContent", () => {
	it("returns DID and ASK lines when stuck is absent", () => {
		const result = buildIntentionSummaryContent({
			did: "x",
			ask: "y",
			trigger: "needs_input",
		});
		expect(result).toBe("DID: x\nASK: y");
	});

	it("includes STUCK line when stuck is present and non-empty", () => {
		const result = buildIntentionSummaryContent({
			did: "x",
			stuck: "z",
			ask: "y",
			trigger: "needs_input",
		});
		expect(result).toBe("DID: x\nSTUCK: z\nASK: y");
	});

	it("omits STUCK line when stuck is empty string", () => {
		const result = buildIntentionSummaryContent({
			did: "x",
			stuck: "",
			ask: "y",
			trigger: "needs_input",
		});
		expect(result).toBe("DID: x\nASK: y");
	});

	it("locks the IntentionSummaryDetails shape at compile time", () => {
		const d: IntentionSummaryDetails = {
			did: "",
			stuck: "",
			ask: "",
			trigger: "pending_approval",
			eventId: "e",
			pending: true,
			superseded: false,
		};
		// Reference every property so TS errors if the shape drifts.
		expect(d.did).toBe("");
		expect(d.stuck).toBe("");
		expect(d.ask).toBe("");
		expect(d.trigger).toBe("pending_approval");
		expect(d.eventId).toBe("e");
		expect(d.pending).toBe(true);
		expect(d.superseded).toBe(false);
	});
});

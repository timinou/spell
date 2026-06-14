import { beforeEach, describe, expect, it } from "bun:test";
import {
	__resetChatIds,
	emptyChat,
	reduceEvent,
	reduceLogEntry,
	type ChatState,
	type StreamRpcEvent,
} from "../../src/detail/chat-model";

function fold(events: StreamRpcEvent[]): ChatState {
	return events.reduce((s, e) => reduceEvent(s, e, 1000), emptyChat());
}

beforeEach(() => __resetChatIds());

describe("reduceEvent — assistant deltas", () => {
	it("accumulates text deltas into one assistant bubble", () => {
		const s = fold([
			{ type: "message_start" },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hel" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lo" } },
			{ type: "message_end" },
		]);
		expect(s.bubbles).toHaveLength(1);
		expect(s.bubbles[0]).toMatchObject({ kind: "assistant", text: "Hello" });
	});

	it("splits thinking and text into distinct bubbles", () => {
		const s = fold([
			{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "answer" } },
		]);
		expect(s.bubbles.map(b => b.kind)).toEqual(["assistant_thinking", "assistant"]);
	});
});

describe("reduceEvent — tool call correlation", () => {
	it("merges start+end into one tool bubble keyed by toolCallId", () => {
		const s = fold([
			{ type: "tool_execution_start", toolCallId: "t1", toolName: "edit", args: { target: "a.ts::Foo" } },
			{ type: "tool_execution_end", toolCallId: "t1", toolName: "edit", result: { content: [{ text: "renamed" }] } },
		]);
		expect(s.bubbles).toHaveLength(1);
		expect(s.bubbles[0]).toMatchObject({ kind: "tool", toolName: "edit", pending: false, resultText: "renamed" });
		expect(s.bubbles[0].args).toEqual({ target: "a.ts::Foo" });
	});

	it("keeps a start pending until its end arrives", () => {
		const s = fold([{ type: "tool_execution_start", toolCallId: "t1", toolName: "find" }]);
		expect(s.bubbles[0].pending).toBe(true);
	});

	it("flags errors on the result", () => {
		const s = fold([
			{ type: "tool_execution_start", toolCallId: "t1", toolName: "bash" },
			{ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: true, result: { content: [{ text: "boom" }] } },
		]);
		expect(s.bubbles[0]).toMatchObject({ isError: true, resultText: "boom" });
	});

	it("synthesises a standalone tile for an orphan end", () => {
		const s = fold([{ type: "tool_execution_end", toolCallId: "x", toolName: "edit", result: { content: [{ text: "ok" }] } }]);
		expect(s.bubbles).toHaveLength(1);
		expect(s.bubbles[0]).toMatchObject({ kind: "tool", resultText: "ok" });
	});
});

describe("reduceEvent — task_ask + error", () => {
	it("raises then resolves an ask in place", () => {
		const s = fold([
			{ type: "task_ask", phase: "raised", questionId: "q1", fromTaskId: "w1", question: "go?" },
			{ type: "task_ask", phase: "answered", questionId: "q1", answer: "yes" },
		]);
		expect(s.bubbles).toHaveLength(1);
		expect(s.bubbles[0].ask).toMatchObject({ status: "answered", answer: "yes" });
	});

	it("appends an error bubble", () => {
		const s = fold([{ type: "error", message: "PeerConflict" }]);
		expect(s.bubbles[0]).toMatchObject({ kind: "error", isError: true, text: "PeerConflict" });
	});
});

describe("reduceLogEntry — external mirroring", () => {
	it("maps log kinds to bubbles and drops turn markers", () => {
		let s = emptyChat();
		s = reduceLogEntry(s, { kind: "user_message", ts: 1, text: "hi" });
		s = reduceLogEntry(s, { kind: "turn_start", ts: 2 });
		s = reduceLogEntry(s, { kind: "tool_call", ts: 3, toolName: "read" });
		expect(s.bubbles.map(b => b.kind)).toEqual(["user", "tool"]);
	});
});

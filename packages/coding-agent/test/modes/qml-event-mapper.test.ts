import { beforeEach, describe, expect, it } from "bun:test";
import { SessionEventMapper } from "../../src/modes/qml-event-mapper";
import type { AgentSessionEvent } from "../../src/session/agent-session";

// Cast helper: tests construct minimal duck-typed fixtures; the mapper operates on
// structural subsets and never accesses the fields the type checker flags as missing.
const ev = (e: unknown) => e as AgentSessionEvent;

// Minimal helpers for message fixture construction.
function assistantMsg(content: Array<{ type: string; text?: string; thinking?: string }> = []) {
	return { role: "assistant" as const, content };
}

function textBlock(text: string) {
	return { type: "text" as const, text };
}

function thinkingBlock(thinking: string) {
	return { type: "thinking" as const, thinking };
}
describe("SessionEventMapper", () => {
	let mapper: SessionEventMapper;

	beforeEach(() => {
		mapper = new SessionEventMapper();
	});

	// ── Message ID threading ──────────────────────────────────────────────────

	describe("message ID threading", () => {
		it("message_start returns a non-empty id", () => {
			const result = mapper.map(ev({ type: "message_start", message: assistantMsg() }));
			expect(result).not.toBeNull();
			expect(typeof (result as Record<string, unknown>).id).toBe("string");
			expect((result as Record<string, unknown>).id).not.toBe("");
		});

		it("message_update and message_end carry the same id as the preceding message_start", () => {
			const startResult = mapper.map(ev({ type: "message_start", message: assistantMsg() }));
			const id = (startResult as Record<string, unknown>).id;

			const updateResult = mapper.map(ev({ type: "message_update", message: assistantMsg([textBlock("hello")]) }));
			const endResult = mapper.map(ev({ type: "message_end", message: assistantMsg() }));

			expect((updateResult as Record<string, unknown>).id).toBe(id);
			expect((endResult as Record<string, unknown>).id).toBe(id);
		});
	});

	// ── Delta text accumulation ───────────────────────────────────────────────

	describe("delta text accumulation", () => {
		beforeEach(() => {
			mapper.map(ev({ type: "message_start", message: assistantMsg() }));
		});

		it("first update returns the full text as delta", () => {
			const result = mapper.map(ev({ type: "message_update", message: assistantMsg([textBlock("hello")]) }));
			expect((result as Record<string, unknown>).text).toBe("hello");
		});

		it("second update returns only the new portion as delta", () => {
			mapper.map(ev({ type: "message_update", message: assistantMsg([textBlock("hello")]) }));
			const result = mapper.map(ev({ type: "message_update", message: assistantMsg([textBlock("hello world")]) }));
			expect((result as Record<string, unknown>).text).toBe(" world");
		});
	});

	// ── Delta reset on new message ────────────────────────────────────────────

	describe("delta reset on new message", () => {
		it("first update of a new message returns full text, not delta from previous message", () => {
			// First full cycle
			mapper.map(ev({ type: "message_start", message: assistantMsg() }));
			mapper.map(ev({ type: "message_update", message: assistantMsg([textBlock("hello world")]) }));
			mapper.map(ev({ type: "message_end", message: assistantMsg() }));

			// Second message
			mapper.map(ev({ type: "message_start", message: assistantMsg() }));
			const result = mapper.map(ev({ type: "message_update", message: assistantMsg([textBlock("hello")]) }));
			// If cursor weren't reset, "hello" is a prefix of "hello world" → delta would be ""
			expect((result as Record<string, unknown>).text).toBe("hello");
		});
	});

	// ── Suppression of empty deltas ───────────────────────────────────────────

	describe("empty delta suppression", () => {
		it("returns null when full text is unchanged and there is no thinking", () => {
			mapper.map(ev({ type: "message_start", message: assistantMsg() }));
			mapper.map(ev({ type: "message_update", message: assistantMsg([textBlock("hello")]) }));
			// Same content again — delta is empty, no thinking
			const result = mapper.map(ev({ type: "message_update", message: assistantMsg([textBlock("hello")]) }));
			expect(result).toBeNull();
		});

		it("returns non-null when there is thinking even if text delta is empty", () => {
			mapper.map(ev({ type: "message_start", message: assistantMsg() }));
			const result = mapper.map(
				ev({ type: "message_update", message: assistantMsg([thinkingBlock("reasoning...")]) }),
			);
			expect(result).not.toBeNull();
			expect((result as Record<string, unknown>).thinking).toBe("reasoning...");
		});
	});

	// ── Tool field mapping ────────────────────────────────────────────────────

	describe("tool field mapping", () => {
		it("tool_execution_start maps toolCallId→id, toolName→name, intent→details", () => {
			const result = mapper.map(
				ev({ type: "tool_execution_start", toolCallId: "call-123", toolName: "bash", intent: "Running build" }),
			);
			expect(result).toEqual({
				type: "tool_start",
				id: "call-123",
				name: "bash",
				details: "Running build",
			});
		});

		it("tool_execution_end maps toolCallId→id, toolName→name, preserves isError", () => {
			const result = mapper.map(
				ev({ type: "tool_execution_end", toolCallId: "call-123", toolName: "bash", isError: true }),
			);
			expect(result).toEqual({
				type: "tool_end",
				id: "call-123",
				name: "bash",
				isError: true,
			});
		});
	});

	// ── Agent busy events ─────────────────────────────────────────────────────

	describe("agent busy events", () => {
		it("agent_start → { type: 'agent_busy', busy: true }", () => {
			expect(mapper.map(ev({ type: "agent_start" }))).toEqual({ type: "agent_busy", busy: true });
		});

		it("agent_end → { type: 'agent_busy', busy: false }", () => {
			expect(mapper.map(ev({ type: "agent_end" }))).toEqual({ type: "agent_busy", busy: false });
		});
	});

	// ── Unrecognized events return null ───────────────────────────────────────

	describe("unrecognized events", () => {
		it("returns null for events the QML UI does not consume", () => {
			// auto_compaction_start is a real event type the mapper ignores
			expect(mapper.map(ev({ type: "auto_compaction_start" }))).toBeNull();
		});
	});

	// ── Instance isolation ────────────────────────────────────────────────────

	describe("instance isolation", () => {
		it("two mappers maintain independent counters and cursors", () => {
			const mapperA = new SessionEventMapper();
			const mapperB = new SessionEventMapper();

			const resultA = mapperA.map(ev({ type: "message_start", message: assistantMsg() }));
			const resultB = mapperB.map(ev({ type: "message_start", message: assistantMsg() }));

			// Both start at msg-1 independently — IDs are per-instance
			expect((resultA as Record<string, unknown>).id).toBe("msg-1");
			expect((resultB as Record<string, unknown>).id).toBe("msg-1");

			// A's second message gets msg-2; B is still at msg-1
			const resultA2 = mapperA.map(ev({ type: "message_start", message: assistantMsg() }));
			expect((resultA2 as Record<string, unknown>).id).toBe("msg-2");
		});
	});
});

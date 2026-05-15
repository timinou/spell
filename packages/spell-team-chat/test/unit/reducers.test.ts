/**
 * Tier 1 — Pure reducer tests (bun:test).
 *
 * No DOM, no runes. The reducers are pure ({state, event}) → state, so we
 * exercise the full SessionState lifecycle without spinning a browser.
 *
 * Mirrors the spell-server StreamRenderer.test.ts shape: tiny inputs, exact
 * outputs, fast.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import {
	__resetBubbleCounterForTests,
	applyRpcEvent,
	appendArtifact,
	appendExternalLog,
	commitPending,
	freshSessionStateCore,
	pushBlocking,
	pushUserBubble,
	type SessionStateCore,
} from "../../src/lib/reducers";
import type { ArtifactCreatedEvent, BlockingEventPayload, RpcEvent } from "../../src/lib/protocol";

beforeEach(() => __resetBubbleCounterForTests());

describe("pushUserBubble", () => {
	it("appends a user bubble and marks busy", () => {
		const next = pushUserBubble(freshSessionStateCore(), "hello", 100);
		expect(next.busy).toBe(true);
		expect(next.bubbles).toHaveLength(1);
		expect(next.bubbles[0]).toMatchObject({ kind: "user", text: "hello", ts: 100 });
	});

	it("preserves prior bubbles (immutable update)", () => {
		const a = pushUserBubble(freshSessionStateCore(), "one", 1);
		const b = pushUserBubble(a, "two", 2);
		expect(a.bubbles).toHaveLength(1);
		expect(b.bubbles).toHaveLength(2);
		expect(a.bubbles).not.toBe(b.bubbles);
	});
});

describe("applyRpcEvent — assistant streaming lifecycle", () => {
	it("message_start creates an empty pending assistant bubble", () => {
		const s = applyRpcEvent(freshSessionStateCore(), { type: "message_start" });
		expect(s.pendingAssistant).toMatchObject({ kind: "assistant", text: "" });
		expect(s.bubbles).toHaveLength(0);
	});

	it("message_update text appends to pending", () => {
		let s = applyRpcEvent(freshSessionStateCore(), { type: "message_start" });
		s = applyRpcEvent(s, {
			type: "message_update",
			assistantMessageEvent: { delta: { text: "Hel" } },
		} as RpcEvent);
		s = applyRpcEvent(s, {
			type: "message_update",
			assistantMessageEvent: { delta: { text: "lo!" } },
		} as RpcEvent);
		expect(s.pendingAssistant?.text).toBe("Hello!");
	});

	it("turn_end commits a non-empty pending to bubbles[]", () => {
		let s: SessionStateCore = { ...freshSessionStateCore(), pendingAssistant: { id: "x", kind: "assistant", ts: 0, text: "done" } };
		s = applyRpcEvent(s, { type: "turn_end" });
		expect(s.pendingAssistant).toBeNull();
		expect(s.bubbles).toHaveLength(1);
		expect(s.bubbles[0]?.text).toBe("done");
	});

	it("turn_end discards an empty pending (no orphan bubbles)", () => {
		// This is the exact bug-protection: avoid empty-assistant bubbles polluting the log.
		let s: SessionStateCore = { ...freshSessionStateCore(), pendingAssistant: { id: "x", kind: "assistant", ts: 0, text: "" } };
		s = applyRpcEvent(s, { type: "turn_end" });
		expect(s.pendingAssistant).toBeNull();
		expect(s.bubbles).toHaveLength(0);
	});

	it("thinking deltas land on assistant_thinking kind", () => {
		let s = applyRpcEvent(freshSessionStateCore(), { type: "message_start" });
		s = applyRpcEvent(s, {
			type: "message_update",
			assistantMessageEvent: { delta: { thinking: "hmm…" } },
		} as RpcEvent);
		expect(s.pendingAssistant?.kind).toBe("assistant_thinking");
		expect(s.pendingAssistant?.text).toBe("hmm…");
	});

	it("text after thinking commits the thinking bubble and starts a new assistant bubble", () => {
		let s = applyRpcEvent(freshSessionStateCore(), { type: "message_start" });
		s = applyRpcEvent(s, {
			type: "message_update",
			assistantMessageEvent: { delta: { thinking: "weighing options" } },
		} as RpcEvent);
		s = applyRpcEvent(s, {
			type: "message_update",
			assistantMessageEvent: { delta: { text: "answer" } },
		} as RpcEvent);
		expect(s.bubbles).toHaveLength(1);
		expect(s.bubbles[0]?.kind).toBe("assistant_thinking");
		expect(s.pendingAssistant?.kind).toBe("assistant");
		expect(s.pendingAssistant?.text).toBe("answer");
	});

	it("agent_end clears busy and commits pending", () => {
		let s: SessionStateCore = {
			...freshSessionStateCore(),
			busy: true,
			pendingAssistant: { id: "x", kind: "assistant", ts: 0, text: "done" },
		};
		s = applyRpcEvent(s, { type: "agent_end" });
		expect(s.busy).toBe(false);
		expect(s.pendingAssistant).toBeNull();
		expect(s.bubbles).toHaveLength(1);
	});
});

describe("applyRpcEvent — tool events", () => {
	it("tool_execution_start commits pending then appends tool_start", () => {
		let s: SessionStateCore = {
			...freshSessionStateCore(),
			pendingAssistant: { id: "x", kind: "assistant", ts: 0, text: "interim" },
		};
		s = applyRpcEvent(s, {
			type: "tool_execution_start",
			toolName: "bash",
			toolCallId: "t1",
			intent: "list files",
		});
		expect(s.bubbles).toHaveLength(2);
		expect(s.bubbles[0]?.kind).toBe("assistant");
		expect(s.bubbles[1]).toMatchObject({ kind: "tool_start", toolName: "bash", intent: "list files" });
		expect(s.pendingAssistant).toBeNull();
	});

	it("tool_execution_end clamps result text to 800 chars", () => {
		const big = "a".repeat(2000);
		const s = applyRpcEvent(freshSessionStateCore(), {
			type: "tool_execution_end",
			toolName: "bash",
			toolCallId: "t1",
			result: { content: [{ text: big }] },
		});
		expect(s.bubbles[0]?.text?.length).toBe(800);
	});
});

describe("applyRpcEvent — error event", () => {
	it("appends an error bubble", () => {
		const s = applyRpcEvent(freshSessionStateCore(), { type: "error", message: "boom" });
		expect(s.bubbles).toHaveLength(1);
		expect(s.bubbles[0]).toMatchObject({ kind: "error", text: "boom" });
	});
});

describe("commitPending", () => {
	it("is a no-op when pendingAssistant is null", () => {
		const s = freshSessionStateCore();
		expect(commitPending(s)).toBe(s);
	});
});

describe("appendArtifact / appendExternalLog / pushBlocking", () => {
	it("appendArtifact attaches the event to a bubble", () => {
		const artifact: ArtifactCreatedEvent = {
			sessionId: "s1",
			uri: "artifact-s1-main-get-0.txt",
			agent: "main",
			tool: "get",
			filename: "0.txt",
			ext: ".txt",
			mime: "text/plain",
			sizeBytes: 12,
			ts: 42,
		};
		const s = appendArtifact(freshSessionStateCore(), artifact);
		expect(s.bubbles[0]).toMatchObject({ kind: "artifact", ts: 42 });
		expect(s.bubbles[0]?.artifact).toBe(artifact);
	});

	it("pushBlocking attaches a blocking payload", () => {
		const payload: BlockingEventPayload = {
			kind: "plan_approval",
			eventId: "evt-1",
			title: "Plan",
			itemId: "PLAN-1",
			planSummary: "do X",
			selectorOptions: ["yes", "no"],
		};
		const s = pushBlocking(freshSessionStateCore(), payload);
		expect(s.bubbles[0]?.kind).toBe("blocking");
		expect(s.bubbles[0]?.blocking).toBe(payload);
	});

	it("appendExternalLog records external session telemetry", () => {
		const s = appendExternalLog(freshSessionStateCore(), {
			kind: "user_message",
			ts: 99,
			text: "from TUI",
			toolName: undefined,
		});
		expect(s.bubbles[0]).toMatchObject({ kind: "external_log", ts: 99, text: "from TUI" });
	});
});

import { describe, expect, it } from "bun:test";
import {
	renderEventLogEntry,
	renderRpcEvent,
	renderTemplateInfo,
} from "../../src/detail/StreamRenderer";

describe("renderRpcEvent", () => {
	it("emits gray bracket for agent_start", () => {
		const out = renderRpcEvent({ type: "agent_start" });
		expect(out).toContain("agent start");
		expect(out).toContain("\u001b[90m");
		expect(out.endsWith("\r\n")).toBe(true);
	});

	it("colors tool_execution_end green on success and red on error", () => {
		const ok = renderRpcEvent({
			type: "tool_execution_end",
			toolName: "bash",
			toolCallId: "1",
		});
		expect(ok).toContain("\u001b[32m");
		expect(ok).toContain("\u2713");
		expect(ok).toContain("bash");
		const fail = renderRpcEvent({
			type: "tool_execution_end",
			toolName: "bash",
			toolCallId: "1",
			isError: true,
		});
		expect(fail).toContain("\u001b[31m");
		expect(fail).toContain("\u2716");
	});

	it("emits intent suffix for tool_execution_start when present", () => {
		const out = renderRpcEvent({
			type: "tool_execution_start",
			toolName: "read",
			toolCallId: "1",
			intent: "Reading config",
		});
		expect(out).toContain("read");
		expect(out).toContain("Reading config");
	});

	it("passes message_update text_delta through unchanged", () => {
		const out = renderRpcEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "hello world" },
		});
		expect(out).toBe("hello world");
	});

	it("formats assistant error events with reason and message", () => {
		const out = renderRpcEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "error",
				reason: "abort",
				error: { errorMessage: "user requested" },
			},
		});
		expect(out).toContain("\u001b[31m");
		expect(out).toContain("abort");
		expect(out).toContain("user requested");
	});

	it("returns empty string for unknown event types", () => {
		expect(renderRpcEvent({ type: "totally_unknown" })).toBe("");
	});
});

describe("renderEventLogEntry", () => {
	const ts = Date.UTC(2026, 0, 1, 12, 34, 56);

	it("includes ISO time slice for known kinds", () => {
		const out = renderEventLogEntry({ kind: "turn_start", ts });
		expect(out).toContain("12:34:56");
	});

	it("renders tool_call with toolName and unknown fallback", () => {
		const named = renderEventLogEntry({ kind: "tool_call", ts, toolName: "grep" });
		expect(named).toContain("grep");
		const anon = renderEventLogEntry({ kind: "tool_call", ts });
		expect(anon).toContain("?");
	});

	it("falls back to the kind label for unknown kinds", () => {
		const out = renderEventLogEntry({ kind: "weird_kind", ts });
		expect(out).toContain("weird_kind");
	});
});

describe("renderTemplateInfo", () => {
	it("includes em-dash separator only when description is present", () => {
		const withDesc = renderTemplateInfo({
			name: "doc",
			description: "Generate report",
			setupRef: "writer",
			prompt: "x",
			params: [],
		});
		expect(withDesc).toContain("doc");
		expect(withDesc).toContain("—");
		expect(withDesc).toContain("Generate report");
		const without = renderTemplateInfo({
			name: "doc",
			setupRef: "writer",
			prompt: "x",
			params: [],
		});
		expect(without).toContain("doc");
		expect(without).not.toContain("—");
	});
});

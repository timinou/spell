import { describe, expect, it } from "bun:test";
import type { AgentStatusContext } from "../src/status-derive";
import { deriveAgentStatus } from "../src/status-derive";

function makeCtx(overrides: Partial<AgentStatusContext> = {}): AgentStatusContext {
	return {
		isStreaming: false,
		todoPhases: [],
		...overrides,
	};
}

describe("deriveAgentStatus", () => {
	it("returns 'error' when error is set, regardless of other flags", () => {
		expect(deriveAgentStatus(makeCtx({ error: "boom", isStreaming: true, isPendingApproval: true }))).toBe("error");
	});

	it("returns 'pending_approval' when isPendingApproval is true (no error)", () => {
		expect(deriveAgentStatus(makeCtx({ isPendingApproval: true, isStreaming: true }))).toBe("pending_approval");
	});

	it("returns 'needs_input' when awaiting hook input (not user-paused)", () => {
		expect(deriveAgentStatus(makeCtx({ isAwaitingHookInput: true }))).toBe("needs_input");
	});

	it("returns 'user_paused' when awaiting hook input and user-paused", () => {
		expect(deriveAgentStatus(makeCtx({ isAwaitingHookInput: true, isUserPaused: true }))).toBe("user_paused");
	});

	it("returns 'running' when streaming", () => {
		expect(deriveAgentStatus(makeCtx({ isStreaming: true }))).toBe("running");
	});

	it("returns 'needs_input' when input callback is present and todos not all done", () => {
		expect(
			deriveAgentStatus(
				makeCtx({
					hasInputCallback: true,
					todoPhases: [{ name: "p1", tasks: [{ id: "t1", content: "do x", status: "pending" }] }],
				}),
			),
		).toBe("needs_input");
	});

	it("returns 'completed' when input callback is present and all todos are done", () => {
		expect(
			deriveAgentStatus(
				makeCtx({
					hasInputCallback: true,
					todoPhases: [{ name: "p1", tasks: [{ id: "t1", content: "do x", status: "completed" }] }],
				}),
			),
		).toBe("completed");
	});

	it("returns 'user_paused' when input callback is present and user-paused", () => {
		expect(
			deriveAgentStatus(
				makeCtx({
					hasInputCallback: true,
					isUserPaused: true,
					todoPhases: [{ name: "p1", tasks: [{ id: "t1", content: "do x", status: "pending" }] }],
				}),
			),
		).toBe("user_paused");
	});

	it("returns 'idle' when nothing is active", () => {
		expect(deriveAgentStatus(makeCtx())).toBe("idle");
	});
});

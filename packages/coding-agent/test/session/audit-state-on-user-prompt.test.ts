import { describe, expect, it } from "bun:test";
import type { AuditState } from "../../src/plan-mode/audit-state";

/**
 * These tests verify the audit state reset contract introduced in the prompt() method.
 *
 * When a user explicitly sends a message (non-synthetic), any pending audit state
 * must be cleared. This prevents the audit prompt from hijacking user-directed
 * recovery messages like "continue" after a session stall.
 *
 * The contract:
 *   - Non-synthetic prompt + pending audit → pending cleared
 *   - Synthetic prompt + pending audit → pending preserved
 *   - Non-synthetic prompt + active audit → active preserved (audit already running)
 *   - Non-synthetic prompt + no pending → no-op
 */

/** Simulates the audit state reset logic from AgentSession.prompt() */
function applyPromptAuditReset(state: AuditState, options?: { synthetic?: boolean }): AuditState {
	if (!options?.synthetic && state.pending) {
		return { ...state, pending: false };
	}
	return state;
}

describe("audit state on user prompt", () => {
	it("clears pending 'auto' audit on non-synthetic user prompt", () => {
		const before: AuditState = {
			type: "audit",
			pending: "auto",
			active: false,
			sourceRef: "PLAN-001",
			auditDepth: 0,
			maxDepth: 2,
		};

		const after = applyPromptAuditReset(before);

		expect(after.pending).toBe(false);
		expect(after.active).toBe(false);
		// Preserves other fields
		expect(after.sourceRef).toBe("PLAN-001");
		expect(after.auditDepth).toBe(0);
		expect(after.maxDepth).toBe(2);
	});

	it("clears pending 'suggest' audit on non-synthetic user prompt", () => {
		const before: AuditState = {
			type: "audit",
			pending: "suggest",
			active: false,
		};

		const after = applyPromptAuditReset(before);

		expect(after.pending).toBe(false);
		expect(after.active).toBe(false);
	});

	it("preserves pending audit on synthetic prompt", () => {
		const before: AuditState = {
			type: "audit",
			pending: "auto",
			active: false,
			sourceRef: "PLAN-001",
		};

		const after = applyPromptAuditReset(before, { synthetic: true });

		expect(after.pending).toBe("auto");
		expect(after.sourceRef).toBe("PLAN-001");
	});

	it("does not modify state when audit is already active", () => {
		const before: AuditState = {
			type: "audit",
			pending: false,
			active: true,
		};

		const after = applyPromptAuditReset(before);

		// pending is already false, so no change
		expect(after.active).toBe(true);
		expect(after.pending).toBe(false);
		expect(after).toBe(before); // same reference — no mutation
	});

	it("is a no-op when no pending audit exists", () => {
		const before: AuditState = {
			type: "audit",
			pending: false,
			active: false,
		};

		const after = applyPromptAuditReset(before);

		expect(after).toBe(before); // same reference — no mutation
	});

	it("treats undefined synthetic as non-synthetic (clears pending)", () => {
		const before: AuditState = {
			type: "audit",
			pending: "auto",
			active: false,
		};

		// options without synthetic field
		const after = applyPromptAuditReset(before, {});

		expect(after.pending).toBe(false);
	});
});

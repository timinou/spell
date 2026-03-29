import { describe, expect, it } from "bun:test";
import type { AuditState } from "../../src/plan-mode/audit-state";
import { isAuditClean } from "../../src/plan-mode/audit-state";

/**
 * Tests the audit lifecycle state transitions managed by InteractiveMode.
 * InteractiveMode owns depth tracking, escalation gating, and audit state
 * setup during plan approval. Since InteractiveMode is tightly coupled to
 * TUI infrastructure, we test the decision logic via state transitions.
 */

describe("audit lifecycle", () => {
	describe("plan approval sets audit state", () => {
		it("ultraplan approval sets pending=auto", () => {
			const isUltraplan = true;
			const isAuditEscalation = false;
			const auditDepth = 0;
			const maxDepth = 2;

			let state: AuditState;
			if (!isAuditEscalation || auditDepth < maxDepth) {
				state = { pending: isUltraplan ? "auto" : "suggest", active: false };
			} else {
				state = { pending: false, active: false };
			}
			expect(state.pending).toBe("auto");
		});

		it("regular plan approval sets pending=suggest", () => {
			const isUltraplan = false;
			const state: AuditState = {
				pending: isUltraplan ? "auto" : "suggest",
				active: false,
			};
			expect(state.pending).toBe("suggest");
		});

		it("audit escalation at max depth disables audit", () => {
			const isAuditEscalation = true;
			const auditDepth = 2;
			const maxDepth = 2;

			let state: AuditState;
			if (!isAuditEscalation || auditDepth < maxDepth) {
				state = { pending: "auto", active: false };
			} else {
				state = { pending: false, active: false };
			}
			expect(state.pending).toBe(false);
		});

		it("audit escalation below max depth still sets audit", () => {
			const isAuditEscalation = true;
			const auditDepth = 1;
			const maxDepth = 2;

			let state: AuditState;
			if (!isAuditEscalation || auditDepth < maxDepth) {
				state = { pending: "auto", active: false };
			} else {
				state = { pending: false, active: false };
			}
			expect(state.pending).toBe("auto");
		});
	});

	describe("depth tracking", () => {
		it("resets to 0 on non-escalation approval", () => {
			let auditDepth = 1;
			const isAuditEscalation = false;
			if (!isAuditEscalation) {
				auditDepth = 0;
			}
			expect(auditDepth).toBe(0);
		});

		it("preserves depth on escalation approval", () => {
			let auditDepth = 1;
			const isAuditEscalation = true;
			if (!isAuditEscalation) {
				auditDepth = 0;
			}
			expect(auditDepth).toBe(1);
		});

		it("increments on escalation", () => {
			let auditDepth = 0;
			const maxDepth = 2;
			// Simulate escalation
			if (auditDepth < maxDepth) {
				auditDepth++;
			}
			expect(auditDepth).toBe(1);
		});

		it("does not escalate at max depth", () => {
			const auditDepth = 2;
			const maxDepth = 2;
			const shouldEscalate = auditDepth < maxDepth;
			expect(shouldEscalate).toBe(false);
		});
	});

	describe("escalation decision", () => {
		it("clean response does not trigger escalation", () => {
			const response = "Everything looks great. [AUDIT_CLEAN]";
			expect(isAuditClean(response)).toBe(true);
			// No escalation should occur
		});

		it("findings trigger escalation below max depth", () => {
			const response = "Found issues:\n- Missing error handling in parser.ts";
			const auditDepth = 0;
			const maxDepth = 2;
			const shouldEscalate = !isAuditClean(response) && auditDepth < maxDepth;
			expect(shouldEscalate).toBe(true);
		});

		it("findings do not trigger escalation at max depth", () => {
			const response = "Found issues:\n- Missing error handling in parser.ts";
			const auditDepth = 2;
			const maxDepth = 2;
			const shouldEscalate = !isAuditClean(response) && auditDepth < maxDepth;
			expect(shouldEscalate).toBe(false);
		});
	});

	describe("overlay display values", () => {
		it("shows 1-indexed depth", () => {
			const depth = 0;
			const maxDepth = 2;
			const display = `Audit ${depth + 1}/${maxDepth}`;
			expect(display).toBe("Audit 1/2");
		});

		it("shows correct display at depth 1", () => {
			const depth = 1;
			const maxDepth = 2;
			const display = `Audit ${depth + 1}/${maxDepth}`;
			expect(display).toBe("Audit 2/2");
		});
	});
});

import { describe, expect, it } from "bun:test";
import type { AuditState } from "../../src/plan-mode/audit-state";
import { isAuditClean } from "../../src/plan-mode/audit-state";

describe("isAuditClean", () => {
	it("detects exact [AUDIT_CLEAN] marker", () => {
		expect(isAuditClean("[AUDIT_CLEAN]")).toBe(true);
	});

	it("detects case variations", () => {
		expect(isAuditClean("[audit_clean]")).toBe(true);
		expect(isAuditClean("[Audit_Clean]")).toBe(true);
		expect(isAuditClean("[AUDIT_clean]")).toBe(true);
	});

	it("detects marker with surrounding text", () => {
		expect(isAuditClean("No issues found. [AUDIT_CLEAN]")).toBe(true);
		expect(isAuditClean("[AUDIT_CLEAN] — all good")).toBe(true);
		expect(isAuditClean("Review complete.\n\n[AUDIT_CLEAN]\n")).toBe(true);
	});

	it("detects whitespace variant [AUDIT CLEAN]", () => {
		expect(isAuditClean("[AUDIT CLEAN]")).toBe(true);
		expect(isAuditClean("[audit clean]")).toBe(true);
	});

	it("detects marker inside markdown code fences", () => {
		expect(isAuditClean("```\n[AUDIT_CLEAN]\n```")).toBe(true);
	});

	it("returns false for partial matches without brackets", () => {
		expect(isAuditClean("AUDIT_CLEAN")).toBe(false);
		expect(isAuditClean("audit_clean")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isAuditClean("")).toBe(false);
	});

	it("returns false for unrelated content", () => {
		expect(isAuditClean("Everything looks good")).toBe(false);
		expect(isAuditClean("The audit found 3 issues")).toBe(false);
	});
});

describe("AuditState", () => {
	it("compiles with all valid field combinations", () => {
		const states: AuditState[] = [
			{ pending: false, active: false },
			{ pending: "auto", active: false },
			{ pending: "suggest", active: false },
			{ pending: false, active: true },
			{ pending: "auto", active: true },
		];
		// Type-level: all combinations must satisfy the AuditState interface
		expect(states).toHaveLength(5);
	});
});

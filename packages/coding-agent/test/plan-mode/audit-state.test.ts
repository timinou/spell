import { describe, expect, it } from "bun:test";
import { DEFAULT_ORG_CONFIG } from "@oh-my-pi/pi-org";
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

	it("accepts optional sourceRef, auditDepth, and maxDepth", () => {
		const state: AuditState = {
			pending: "auto",
			active: false,
			sourceRef: "org://PLAN-027-foo",
			auditDepth: 0,
			maxDepth: 2,
		};
		expect(state.sourceRef).toBe("org://PLAN-027-foo");
		expect(state.auditDepth).toBe(0);
		expect(state.maxDepth).toBe(2);
	});

	it("allows omitting optional fields", () => {
		const state: AuditState = { pending: false, active: false };
		expect(state.sourceRef).toBeUndefined();
		expect(state.auditDepth).toBeUndefined();
		expect(state.maxDepth).toBeUndefined();
	});
});

describe("audits org category", () => {
	it("exists in DEFAULT_ORG_CONFIG with AUD prefix", () => {
		const tasks = DEFAULT_ORG_CONFIG.dirs.tasks;
		expect(tasks.categories.audits).toBeDefined();
		expect(tasks.categories.audits.prefix).toBe("AUD");
		expect(tasks.categories.audits.path).toBe("audits");
	});
});

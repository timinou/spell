import { describe, expect, it } from "bun:test";
import { buildOrgQlSexp, parseKeywordQuery, requiresEmacs } from "../src/query-builder";

const LOOP_PREDICATES_FILE = new URL("../elisp/tools/loop-predicates.el", import.meta.url);

describe("loop predicates", () => {
	it("builds loop-specific org-ql sexps and marks them as Emacs-only", () => {
		const filter = parseKeywordQuery(
			"loop-status:iterating loop-depth:1 loop-blocked acceptance-failed dependency-chain:LOOP-1",
		);
		const sexp = buildOrgQlSexp(filter);
		expect(sexp).toContain('(loop-status "iterating")');
		expect(sexp).toContain("(loop-depth 1)");
		expect(sexp).toContain("(loop-blocked)");
		expect(sexp).toContain("(acceptance-failed)");
		expect(sexp).toContain('(dependency-chain "LOOP-1")');
		expect(requiresEmacs(filter)).toBe(true);
	});

	it("defines the custom org-ql predicates in elisp", async () => {
		const content = await Bun.file(LOOP_PREDICATES_FILE).text();
		expect(content).toContain("org-ql-defpred loop-status");
		expect(content).toContain("org-ql-defpred loop-blocked");
		expect(content).toContain("org-ql-defpred acceptance-failed");
		expect(content).toContain("org-ql-defpred dependency-chain");
		expect(content).toContain("org-ql-defpred loop-depth");
	});
});

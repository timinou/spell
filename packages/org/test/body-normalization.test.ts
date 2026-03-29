import { describe, expect, it } from "bun:test";
import { normalizeOrgBody } from "../src/tool";

describe("normalizeOrgBody", () => {
	it("converts literal backslash-n to real newlines", () => {
		expect(normalizeOrgBody("line1\\nline2")).toBe("line1\nline2");
	});

	it("converts literal backslash-t to real tabs", () => {
		expect(normalizeOrgBody("col1\\tcol2")).toBe("col1\tcol2");
	});

	it("converts double backslash-n paragraph breaks", () => {
		expect(normalizeOrgBody("para1\\n\\npara2")).toBe("para1\n\npara2");
	});

	it("passes through already-real newlines unchanged", () => {
		expect(normalizeOrgBody("line1\nline2")).toBe("line1\nline2");
	});

	it("handles mixed real and literal newlines", () => {
		expect(normalizeOrgBody("real\nand\\nliteral")).toBe("real\nand\nliteral");
	});

	it("passes through empty string unchanged", () => {
		expect(normalizeOrgBody("")).toBe("");
	});

	it("passes through undefined unchanged", () => {
		expect(normalizeOrgBody(undefined)).toBeUndefined();
	});
});

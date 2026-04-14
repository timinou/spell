import { describe, expect, test } from "bun:test";
import { rewriteSubOutlineIds } from "../src/sub-outline-rewrite";

describe("rewriteSubOutlineIds", () => {
	const parentId = "FEAT-542";

	test("prefixes short sub-outline CUSTOM_ID values on create", () => {
		const input = ["** Define types", ":PROPERTIES:", ":CUSTOM_ID: define-types", ":END:"].join("\n");

		expect(rewriteSubOutlineIds(parentId, input)).toEqual({
			body: ["** Define types", ":PROPERTIES:", `:CUSTOM_ID: ${parentId}::define-types`, ":END:"].join("\n"),
			rewrites: new Map([["define-types", `${parentId}::define-types`]]),
		});
	});

	test("rewrites local DEPENDS references", () => {
		const input = [
			"** Define types",
			":PROPERTIES:",
			":CUSTOM_ID: define-types",
			":END:",
			"",
			"** Wire types",
			":PROPERTIES:",
			":CUSTOM_ID: wire-types",
			":DEPENDS: define-types",
			":END:",
		].join("\n");

		const result = rewriteSubOutlineIds(parentId, input);
		expect(result.body).toContain(`:DEPENDS: ${parentId}::define-types`);
	});

	test("does not rewrite cross-item DEPENDS references", () => {
		const input = [
			"** Wire types",
			":PROPERTIES:",
			":CUSTOM_ID: wire-types",
			":DEPENDS: OTHER-ITEM::step",
			":END:",
		].join("\n");

		const result = rewriteSubOutlineIds(parentId, input);
		expect(result.body).toContain(":DEPENDS: OTHER-ITEM::step");
	});

	test("does not double-prefix already-prefixed CUSTOM_ID values", () => {
		const input = ["** Define types", ":PROPERTIES:", `:CUSTOM_ID: ${parentId}::define-types`, ":END:"].join("\n");

		const result = rewriteSubOutlineIds(parentId, input);
		expect(result.body).toBe(input);
		expect(result.rewrites.size).toBe(0);
	});

	test("prefixes short IDs during update with existing parent ID", () => {
		const input = ["** Rewrite body", ":PROPERTIES:", ":CUSTOM_ID: rewrite-body", ":END:"].join("\n");

		const result = rewriteSubOutlineIds("PLAN-224-org-tool-ergonomic-improvements", input);
		expect(result.body).toContain(":CUSTOM_ID: PLAN-224-org-tool-ergonomic-improvements::rewrite-body");
	});

	test("passes through body with no sub-outline headings", () => {
		const input = "Plain body text only";
		const result = rewriteSubOutlineIds(parentId, input);
		expect(result.body).toBe(input);
		expect(result.rewrites.size).toBe(0);
	});

	test("rewrites mixed local and cross-item DEPENDS tokens", () => {
		const input = [
			"** Define types",
			":PROPERTIES:",
			":CUSTOM_ID: define-types",
			":END:",
			"",
			"** Wire types",
			":PROPERTIES:",
			":CUSTOM_ID: wire-types",
			":DEPENDS: define-types OTHER-ITEM::step external-id",
			":END:",
		].join("\n");

		const result = rewriteSubOutlineIds(parentId, input);
		expect(result.body).toContain(`:DEPENDS: ${parentId}::define-types OTHER-ITEM::step external-id`);
	});

	test("returns empty rewrites for empty body", () => {
		const result = rewriteSubOutlineIds(parentId, "");
		expect(result).toEqual({ body: "", rewrites: new Map() });
	});
});

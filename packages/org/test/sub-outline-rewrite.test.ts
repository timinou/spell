import { describe, expect, test } from "bun:test";
import { rewriteSubOutlineIds } from "../src/sub-outline-rewrite";

describe("rewriteSubOutlineIds", () => {
	const parentId = "FEAT-603";
	const assignedParentId = "BUG-123-fix-thing";

	test("prefixes short sub-outline CUSTOM_ID values on create", () => {
		const input = ["** ITEM Define types", ":PROPERTIES:", ":CUSTOM_ID: define-types", ":END:"].join("\n");

		expect(rewriteSubOutlineIds(parentId, input)).toEqual({
			body: ["** ITEM Define types", ":PROPERTIES:", `:CUSTOM_ID: ${parentId}::define-types`, ":END:"].join("\n"),
			rewrites: new Map([["define-types", `${parentId}::define-types`]]),
		});
	});

	test("rewrites local DEPENDS references", () => {
		const input = [
			"** ITEM Define types",
			":PROPERTIES:",
			":CUSTOM_ID: define-types",
			":END:",
			"",
			"** ITEM Wire types",
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
			"** ITEM Wire types",
			":PROPERTIES:",
			":CUSTOM_ID: wire-types",
			":DEPENDS: OTHER-ITEM::step",
			":END:",
		].join("\n");

		const result = rewriteSubOutlineIds(parentId, input);
		expect(result.body).toContain(":DEPENDS: OTHER-ITEM::step");
	});

	test("does not double-prefix already-prefixed CUSTOM_ID values", () => {
		const input = ["** ITEM Define types", ":PROPERTIES:", `:CUSTOM_ID: ${parentId}::define-types`, ":END:"].join(
			"\n",
		);

		const result = rewriteSubOutlineIds(parentId, input);
		expect(result.body).toBe(input);
		expect(result.rewrites.size).toBe(0);
	});

	test("prefixes short IDs during update with existing parent ID", () => {
		const input = ["** ITEM Rewrite body", ":PROPERTIES:", ":CUSTOM_ID: rewrite-body", ":END:"].join("\n");

		const result = rewriteSubOutlineIds("PLAN-224-org-tool-ergonomic-improvements", input);
		expect(result.body).toContain(":CUSTOM_ID: PLAN-224-org-tool-ergonomic-improvements::rewrite-body");
	});

	describe("empty-left normalization", () => {
		test("rewrite_accepts_empty_left_colon_colon_suffix", () => {
			const input = ["** ITEM Define types", ":PROPERTIES:", ":CUSTOM_ID: ::slug", ":END:"].join("\n");

			const result = rewriteSubOutlineIds(parentId, input);
			expect(result.body).toContain(`:CUSTOM_ID: ${parentId}::slug`);
			expect(result.rewrites).toEqual(new Map([["::slug", `${parentId}::slug`]]));
		});

		test("rewrite_depends_accepts_empty_left_colon_colon", () => {
			const input = [
				"** ITEM Follow up",
				":PROPERTIES:",
				":CUSTOM_ID: follow-up",
				":DEPENDS: ::a ::b",
				":END:",
			].join("\n");

			const result = rewriteSubOutlineIds(parentId, input);
			expect(result.body).toContain(`:DEPENDS: ${parentId}::a ${parentId}::b`);
		});

		test("rewrite_mixes_empty_left_with_bare_and_fully_qualified", () => {
			const input = [
				"** ITEM Follow up",
				":PROPERTIES:",
				":CUSTOM_ID: follow-up",
				`:DEPENDS: ::a raw-b ${parentId}::c`,
				":END:",
			].join("\n");

			const result = rewriteSubOutlineIds(parentId, input);
			expect(result.body).toContain(`:DEPENDS: ${parentId}::a ${parentId}::raw-b ${parentId}::c`);
		});

		test("rewrite_rejects_empty_left_with_invalid_suffix", () => {
			const input = ["** ITEM Invalid suffix", ":PROPERTIES:", ":CUSTOM_ID: ::$bad", ":END:"].join("\n");

			const result = rewriteSubOutlineIds(parentId, input);
			expect(result.body).toBe(input);
			expect(result.rewrites.size).toBe(0);
		});
	});

	describe("ITEM injection", () => {
		test("inject_item_on_bare_heading_with_local_custom_id", () => {
			const input = ["** Implement parser", ":PROPERTIES:", ":CUSTOM_ID: ::parser", ":END:"].join("\n");

			const result = rewriteSubOutlineIds(parentId, input);
			expect(result.body).toContain("** ITEM Implement parser");
			expect(result.body).toContain(`:CUSTOM_ID: ${parentId}::parser`);
		});

		test("inject_does_not_touch_heading_that_already_has_state", () => {
			const input = ["** DONE Ship parser", ":PROPERTIES:", ":CUSTOM_ID: ::parser", ":END:"].join("\n");

			const result = rewriteSubOutlineIds(parentId, input);
			expect(result.body).toContain("** DONE Ship parser");
			expect(result.body).not.toContain("** ITEM DONE Ship parser");
		});

		test("inject_does_not_touch_heading_without_sub_outline_custom_id", () => {
			const input = ["** Plain note", "This heading has no properties drawer."].join("\n");

			const result = rewriteSubOutlineIds(parentId, input);
			expect(result.body).toBe(input);
		});

		test("inject_does_not_touch_top_level_heading", () => {
			const input = ["* Top level", ":PROPERTIES:", ":CUSTOM_ID: ::root", ":END:"].join("\n");

			const result = rewriteSubOutlineIds(parentId, input);
			expect(result.body).toContain("* Top level");
			expect(result.body).not.toContain("* ITEM Top level");
		});

		test("inject_handles_multiple_sub_outline_headings_in_one_body", () => {
			const input = [
				"** First task",
				":PROPERTIES:",
				":CUSTOM_ID: first-task",
				":END:",
				"",
				"** Second task",
				":PROPERTIES:",
				":CUSTOM_ID: ::second-task",
				":END:",
				"",
				"** Third task",
				":PROPERTIES:",
				":CUSTOM_ID: FEAT-603::third-task",
				":END:",
			].join("\n");

			const result = rewriteSubOutlineIds(parentId, input);
			expect(result.body).toContain("** ITEM First task");
			expect(result.body).toContain("** ITEM Second task");
			expect(result.body).toContain("** ITEM Third task");
		});

		test("inject_respects_foreign_parent_custom_id", () => {
			const input = ["** Foreign parent", ":PROPERTIES:", ":CUSTOM_ID: FEAT-999::child", ":END:"].join("\n");

			const result = rewriteSubOutlineIds(parentId, input);
			expect(result.body).toBe(input);
			expect(result.rewrites.size).toBe(0);
		});
	});

	test("rewrites wrong-prefix CUSTOM_ID values when numeric prefix matches", () => {
		const input = ["** ITEM Define types", ":PROPERTIES:", ":CUSTOM_ID: BUG-123::define-types", ":END:"].join("\n");

		const result = rewriteSubOutlineIds(assignedParentId, input);
		expect(result.body).toContain(":CUSTOM_ID: BUG-123-fix-thing::define-types");
		expect(result.rewrites).toEqual(new Map([["BUG-123::define-types", "BUG-123-fix-thing::define-types"]]));
	});

	test("rewrites wrong-prefix and bare DEPENDS tokens with the assigned parent id", () => {
		const input = [
			"** ITEM Define types",
			":PROPERTIES:",
			":CUSTOM_ID: BUG-123::define-types",
			":END:",
			"",
			"** ITEM Wire types",
			":PROPERTIES:",
			":CUSTOM_ID: wire-types",
			":DEPENDS: BUG-123::define-types define-types BUG-123-fix-thing::define-types",
			":END:",
		].join("\n");

		const result = rewriteSubOutlineIds(assignedParentId, input);
		expect(result.body).toContain(
			":DEPENDS: BUG-123-fix-thing::define-types BUG-123-fix-thing::define-types BUG-123-fix-thing::define-types",
		);
	});

	test("leaves invalid suffixes untouched instead of producing invalid ids", () => {
		const input = [
			"** ITEM Invalid suffix",
			":PROPERTIES:",
			":CUSTOM_ID: BUG-123::bad:id",
			":DEPENDS: BUG-123::bad:id",
			":END:",
		].join("\n");

		const result = rewriteSubOutlineIds(assignedParentId, input);
		expect(result.body).toBe(input);
		expect(result.rewrites.size).toBe(0);
	});

	test("returns empty rewrites for empty body", () => {
		const result = rewriteSubOutlineIds(parentId, "");
		expect(result).toEqual({ body: "", rewrites: new Map() });
	});
});

import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { editOpSchema } from "@oh-my-pi/pi-coding-agent/tools/codepath-types";

/**
 * PLAN-304 negative-shape rejection tests
 * 
 * Every impossible Op shape MUST be rejected by the discriminated-union schema.
 * TypeBox enforces target shape constraints (bare path vs symbol path), required fields, and enum values.
 */

describe("PLAN-304 negative-shape rejection", () => {
	test.each([
		// Target shape violations
		["fileWrite with symbol target", { kind: "fileWrite", target: "a.ts::Foo", content: "x" }],
		["fileDelete with symbol target", { kind: "fileDelete", target: "a.ts::Bar" }],
		["fileAppend with symbol target", { kind: "fileAppend", target: "a.ts::Baz", content: "x" }],
		["filePrepend with symbol target", { kind: "filePrepend", target: "a.ts::Qux", content: "x" }],
		["filePatch with symbol target", { kind: "filePatch", target: "a.ts::X", diff: "..." }],
		["fileFindReplace with symbol", { kind: "fileFindReplace", target: "a.ts::Foo", find: "x", content: "y" }],

		["symbolReplace with bare target", { kind: "symbolReplace", target: "a.ts", content: "x" }],
		["symbolRename with bare target", { kind: "symbolRename", target: "a.ts", newName: "bar" }],
		["symbolWrap with bare target", { kind: "symbolWrap", target: "a.ts", content: "x" }],
		["symbolDelete with bare target", { kind: "symbolDelete", target: "a.ts" }],
		["symbolInsertBefore bare", { kind: "symbolInsertBefore", target: "a.ts", content: "x" }],
		["symbolInsertAfter bare", { kind: "symbolInsertAfter", target: "a.ts", content: "x" }],
		["symbolFindReplace bare", { kind: "symbolFindReplace", target: "a.ts", find: "x", content: "y" }],
		["symbolRawTextReplace bare", { kind: "symbolRawTextReplace", target: "a.ts", find: "x", content: "y" }],

		// Missing required fields
		["symbolRename missing newName", { kind: "symbolRename", target: "a.ts::Foo" }],
		["symbolReplace missing content", { kind: "symbolReplace", target: "a.ts::Foo" }],
		["fileWrite missing content", { kind: "fileWrite", target: "a.ts" }],
		["symbolFindReplace missing find", { kind: "symbolFindReplace", target: "a.ts::Foo", content: "y" }],
		["symbolFindReplace missing content", { kind: "symbolFindReplace", target: "a.ts::Foo", find: "x" }],
		["lineReplace missing span", { kind: "lineReplace", target: "a.ts", content: "x" }],
		["lineInsert missing at", { kind: "lineInsert", target: "a.ts", content: "x" }],
		["lineAppend missing at", { kind: "lineAppend", target: "a.ts", content: "x" }],
		["linePrepend missing at", { kind: "linePrepend", target: "a.ts", content: "x" }],

		// Invalid enum values
		["scope=banana", { kind: "symbolReplace", target: "a.ts::Foo", scope: "banana", content: "x" }],
		["symbolMove invalid direction", { kind: "symbolMove", target: "a.ts::Foo", direction: "sideways" }],
		["symbolSplice invalid mode", { kind: "symbolSplice", target: "a.ts::Foo", mode: "sideways" }],
		["occurrence=zero", { kind: "symbolFindReplace", target: "a.ts::Foo", find: "x", content: "y", occurrence: 0 }],
		["occurrence=negative", { kind: "symbolFindReplace", target: "a.ts::Foo", find: "x", content: "y", occurrence: -1 }],

		// Unknown kind
		["unknown kind", { kind: "writeFile", target: "a.ts" }],
		["legacy write (unmapped)", { kind: "write", target: "a.ts", content: "x" }],

		// Invalid line anchor format
		["lineReplace bad anchor", { kind: "lineReplace", target: "a.ts", span: { start: "42" }, content: "x" }],
		["lineAppend bad anchor", { kind: "lineAppend", target: "a.ts", at: "42", content: "x" }],

		// Type mismatches
		["content=number", { kind: "fileWrite", target: "a.ts", content: 42 }],
		["force=string", { kind: "fileWrite", target: "a.ts", content: "x", force: "yes" }],
		["column=string", { kind: "symbolTranspose", target: "a.ts::Foo", column: "first" }],
	])("rejects: %s", (_label, op) => {
		const result = Value.Check(editOpSchema, op);
		if (result) {
			// If it passes, show what errors should have been
			const errors = [...Value.Errors(editOpSchema, op)];
			console.log(`Unexpected pass for ${_label}. Schema errors that should exist:`, errors);
		}
		expect(result).toBe(false);
	});

	test("accepts valid fileWrite", () => {
		expect(Value.Check(editOpSchema, { kind: "fileWrite", target: "a.ts", content: "x" })).toBe(true);
	});

	test("accepts valid symbolReplace", () => {
		expect(Value.Check(editOpSchema, { kind: "symbolReplace", target: "a.ts::Foo", content: "x" })).toBe(true);
	});

	test("accepts symbolReplace with scope=body", () => {
		expect(
			Value.Check(editOpSchema, { kind: "symbolReplace", target: "a.ts::Foo", scope: "body", content: "x" }),
		).toBe(true);
	});

	test("accepts lineReplace with valid span", () => {
		expect(
			Value.Check(editOpSchema, {
				kind: "lineReplace",
				target: "a.ts",
				span: { start: "42#AB" },
				content: "x",
			}),
		).toBe(true);
	});

	test("accepts lineInsert with valid at", () => {
		expect(
			Value.Check(editOpSchema, {
				kind: "lineInsert",
				target: "a.ts",
				at: { side: "before", anchor: "42#AB" },
				content: "x",
			}),
		).toBe(true);
	});
});

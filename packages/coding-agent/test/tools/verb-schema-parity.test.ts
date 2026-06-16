/**
 * PLAN-321 verb-surface parity gate.
 *
 * The edit tool's external action is the hand-authored 6-verb `Verb` surface
 * (`verb-schema.ts`), not the kernel-generated 31-op schema. Because it is
 * hand-authored, drift from the Rust `Verb` enum is possible — so this test
 * pins the TS union's `kind` literals against the kernel's `listVerbKinds()`
 * introspection (the same source the Rust `Verb` enum is checked against).
 *
 * A mismatch means someone added/removed/renamed a verb on one side only.
 */

import { expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import {
	deleteVerb,
	patchVerb,
	renameVerb,
	replaceVerb,
	restructureVerb,
	VERB_KINDS,
	verbActionSchema,
} from "@spell/pi-coding-agent/tools/verb-schema";
import { listVerbKinds } from "@spell/pi-natives";

test("TS VERB_KINDS matches kernel listVerbKinds()", () => {
	const kernel = listVerbKinds();
	expect([...VERB_KINDS] as string[]).toEqual(kernel);
});

test("every kernel verb kind is accepted by the TS action union", () => {
	// One minimal valid sample per kind; proves the union has a member for each.
	const samples: Record<string, unknown> = {
		replace: { kind: "replace", content: "x" },
		rename: { kind: "rename", to: "y" },
		delete: { kind: "delete" },
		patch: { kind: "patch", diff: "d" },
		restructure: { kind: "restructure", op: "demote" },
		undo: { kind: "undo" },
		redo: { kind: "redo" },
	};
	for (const kind of listVerbKinds()) {
		const sample = samples[kind];
		expect(sample, `no sample for kernel verb kind '${kind}'`).toBeDefined();
		expect(Value.Check(verbActionSchema, sample), `union rejects '${kind}'`).toBe(true);
	}
});

test("replace optional fields are accepted", () => {
	expect(
		Value.Check(replaceVerb, {
			kind: "replace",
			content: "x",
			find: "old",
			matching: "raw",
			occurrence: "all",
		}),
	).toBe(true);
	expect(Value.Check(replaceVerb, { kind: "replace", content: "x", place: "after", at: 40 })).toBe(true);
	expect(Value.Check(replaceVerb, { kind: "replace", content: "x", find: "anchor", place: "after" })).toBe(
		true,
	);
});

test("replace rejects stale optional-field pollution", () => {
	expect(Value.Check(replaceVerb, { kind: "replace", content: "x", find: "old", place: "end" })).toBe(false);
	expect(Value.Check(replaceVerb, { kind: "replace", content: "x", find: "old", place: "after", at: 40 })).toBe(false);
});

test("restructure flattened tagged-union variants validate", () => {
	expect(Value.Check(restructureVerb, { kind: "restructure", op: "move", direction: "up" })).toBe(true);
	expect(Value.Check(restructureVerb, { kind: "restructure", op: "transpose", column: 3 })).toBe(true);
	expect(Value.Check(restructureVerb, { kind: "restructure", op: "splice", mode: "self" })).toBe(true);
	expect(Value.Check(restructureVerb, { kind: "restructure", op: "clone", renameTo: "copy" })).toBe(true);
	expect(Value.Check(restructureVerb, { kind: "restructure", op: "promote" })).toBe(true);
	// missing required discriminant field is rejected
	expect(Value.Check(restructureVerb, { kind: "restructure", op: "move" })).toBe(false);
});

test("verbs reject unknown fields (additionalProperties:false)", () => {
	expect(Value.Check(renameVerb, { kind: "rename", to: "x", bogus: 1 })).toBe(false);
	expect(Value.Check(deleteVerb, { kind: "delete", scope: "body" })).toBe(false);
	expect(Value.Check(patchVerb, { kind: "patch", diff: "d", extra: true })).toBe(false);
});

// ── Hand-authored verb surface schema (PLAN-321) ──
//
// The edit tool's external `action` is the 6-verb `Verb` surface, NOT the 31
// kernel Op kinds. Verbs are a *designed* API (stable, bespoke shapes), so —
// unlike the kernel-Op mirror in `codepath-op-schema.generated.ts` — this
// schema is hand-authored. Parity with the Rust `Verb` enum is guarded by a
// kind-parity test against `listVerbKinds()` (kernel introspection), so the
// two cannot silently drift.
//
// Family (file / symbol / line / css / heading) is NEVER named here — the
// kernel infers it from the CodePath `target` shape and lowers the verb to the
// precise Op (`Verb::lower`). That inference is the whole point of the cutover.

import { type Static, Type } from "@sinclair/typebox";
import { contentSchema, directionSchema, occurrenceSchema, spliceModeSchema } from "./codepath-primitives";

// ── replace ──
// The workhorse: overwrite / body / sig / find-replace / structural / line-
// range / insert / heading-block — selected by target shape + which optional
// fields are present.
export const replaceVerb = Type.Object(
	{
		kind: Type.Literal("replace"),
		content: contentSchema,
		find: Type.Optional(
			Type.Union([contentSchema], { description: "Pattern to locate within the target scope (find-and-replace)" }),
		),
		matching: Type.Optional(
			Type.Union([Type.Literal("structural"), Type.Literal("raw")], {
				description: "structural (default, tree-sitter/word-boundary aware) | raw (byte-literal)",
			}),
		),
		place: Type.Optional(
			Type.Union([Type.Literal("start"), Type.Literal("end"), Type.Literal("before"), Type.Literal("after")], {
				description:
					"Insertion mode: start|end (file prepend/append) · before|after (symbol or, with `at`, a file line)",
			}),
		),
		at: Type.Optional(
			Type.Integer({ minimum: 1, description: "1-indexed line anchor for place:before|after on a file target" }),
		),
		occurrence: Type.Optional(occurrenceSchema),
	},
	{
		additionalProperties: false,
		description: "Replace / insert / find-replace — behaviour selected by target shape + fields",
	},
);

// ── rename ──
// Identifier-aware: symbol (+ in-file refs) or CSS token. CSS namespace comes
// from the selector sigil in the target (.cls / #id / --prop).
export const renameVerb = Type.Object(
	{
		kind: Type.Literal("rename"),
		to: Type.String({ description: "New identifier / token name" }),
	},
	{
		additionalProperties: false,
		description: "Rename a symbol or CSS token (namespace inferred from target selector)",
	},
);

// ── delete ──
export const deleteVerb = Type.Object(
	{
		kind: Type.Literal("delete"),
		allowSiblingDelete: Type.Optional(
			Type.Boolean({ description: "Permit removing the last declaration in a group (default false)" }),
		),
	},
	{ additionalProperties: false, description: "Delete a file, symbol, or dead CSS rule (by target shape)" },
);

// ── patch ──
export const patchVerb = Type.Object(
	{
		kind: Type.Literal("patch"),
		diff: Type.String({ description: "Unified diff to apply to the file target" }),
	},
	{ additionalProperties: false, description: "Apply a raw unified diff (escape hatch for pre-existing diffs)" },
);

// ── restructure ──
// AST surgery. `op` is a flattened tagged union mirroring Rust `RestructureOp`:
// the discriminant field is `op`, with per-op fields alongside it.
export const restructureVerb = Type.Union(
	[
		Type.Object(
			{ kind: Type.Literal("restructure"), op: Type.Literal("move"), direction: directionSchema },
			{ additionalProperties: false, description: "Reorder among siblings by one slot" },
		),
		Type.Object(
			{ kind: Type.Literal("restructure"), op: Type.Literal("transpose"), column: Type.Integer({ minimum: 0 }) },
			{ additionalProperties: false, description: "Reorder to an explicit 1-indexed sibling slot" },
		),
		Type.Object(
			{ kind: Type.Literal("restructure"), op: Type.Literal("splice"), mode: spliceModeSchema },
			{ additionalProperties: false, description: "Unwrap a node, promoting/absorbing its children" },
		),
		Type.Object(
			{
				kind: Type.Literal("restructure"),
				op: Type.Literal("clone"),
				renameTo: Type.Optional(Type.String({ description: "Clone destination name (optional)" })),
			},
			{ additionalProperties: false, description: "Duplicate a declaration, optionally under a new name" },
		),
		Type.Object(
			{ kind: Type.Literal("restructure"), op: Type.Literal("promote") },
			{ additionalProperties: false, description: "Heading level up (## → #)" },
		),
		Type.Object(
			{ kind: Type.Literal("restructure"), op: Type.Literal("demote") },
			{ additionalProperties: false, description: "Heading level down (# → ##)" },
		),
	],
	{ description: "AST surgery: move / transpose / splice / clone / heading promote-demote" },
);

// ── history ── (dispatched alone; target ignored)
export const undoVerb = Type.Object(
	{ kind: Type.Literal("undo") },
	{ additionalProperties: false, description: "Undo the last edit transaction (dispatch alone)" },
);
export const redoVerb = Type.Object(
	{ kind: Type.Literal("redo") },
	{ additionalProperties: false, description: "Redo the most recently undone transaction (dispatch alone)" },
);

// ── union ──
export const verbActionSchema = Type.Union([
	replaceVerb,
	renameVerb,
	deleteVerb,
	patchVerb,
	restructureVerb,
	undoVerb,
	redoVerb,
]);

export type VerbAction = Static<typeof verbActionSchema>;

/** Verb-surface kinds, surface order. Mirrors kernel `list_verb_kinds()`. */
export const VERB_KINDS = ["replace", "rename", "delete", "patch", "restructure", "undo", "redo"] as const;

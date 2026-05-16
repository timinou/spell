// ── AUTO-GENERATED — DO NOT EDIT ──
// Source: kernel Op enum via list_ops() NAPI introspection
// Refresh: bun run gen:op-schema

import { type Static, Type } from "@sinclair/typebox";
import {
	contentSchema,
	filePathSchema,
	symbolPathSchema,
	lineAnchorSchema,
	lineSpanSchema,
	lineAtSchema,
	occurrenceSchema,
	directionSchema,
	spliceModeSchema,
	symScopeSchema,
} from "./codepath-primitives";

// ── Per-variant Op schemas ──
// Each corresponds 1:1 to a variant in the Rust `Op` enum.

export const fileCreateOp = Type.Object(
	{
		kind: Type.Literal("fileCreate"),
		target: filePathSchema,
		content: contentSchema,
		force: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false, description: "Create a new file with given content" },
);
export const fileWriteOp = Type.Object(
	{
		kind: Type.Literal("fileWrite"),
		target: filePathSchema,
		content: contentSchema,
		force: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false, description: "Replace the full content of an existing file" },
);
export const fileDeleteOp = Type.Object(
	{
		kind: Type.Literal("fileDelete"),
		target: filePathSchema,
	},
	{ additionalProperties: false, description: "Delete a file from the filesystem" },
);
export const fileAppendOp = Type.Object(
	{
		kind: Type.Literal("fileAppend"),
		target: filePathSchema,
		content: contentSchema,
	},
	{ additionalProperties: false, description: "Append content to the end of a file" },
);
export const filePrependOp = Type.Object(
	{
		kind: Type.Literal("filePrepend"),
		target: filePathSchema,
		content: contentSchema,
	},
	{ additionalProperties: false, description: "Prepend content to the beginning of a file" },
);
export const filePatchOp = Type.Object(
	{
		kind: Type.Literal("filePatch"),
		target: filePathSchema,
		diff: Type.String({ description: "unified diff" }),
	},
	{ additionalProperties: false, description: "Apply a unified diff patch to a file" },
);
export const fileFindReplaceOp = Type.Object(
	{
		kind: Type.Literal("fileFindReplace"),
		target: filePathSchema,
		find: contentSchema,
		content: contentSchema,
		occurrence: Type.Optional(occurrenceSchema),
	},
	{
		additionalProperties: false,
		description: "Find-and-replace within a file using structural matching (tree-sitter aware)",
	},
);
export const fileRawTextReplaceOp = Type.Object(
	{
		kind: Type.Literal("fileRawTextReplace"),
		target: filePathSchema,
		find: contentSchema,
		content: contentSchema,
		occurrence: Type.Optional(occurrenceSchema),
	},
	{ additionalProperties: false, description: "Find-and-replace within a file using raw text matching" },
);
export const lineReplaceOp = Type.Object(
	{
		kind: Type.Literal("lineReplace"),
		target: filePathSchema,
		span: lineSpanSchema,
		content: contentSchema,
	},
	{ additionalProperties: false, description: "Replace a range of lines with new content" },
);
export const lineInsertOp = Type.Object(
	{
		kind: Type.Literal("lineInsert"),
		target: filePathSchema,
		at: lineAtSchema,
		content: contentSchema,
	},
	{ additionalProperties: false, description: "Insert content at a specific line number" },
);
export const lineAppendOp = Type.Object(
	{
		kind: Type.Literal("lineAppend"),
		target: filePathSchema,
		at: lineAnchorSchema,
		content: contentSchema,
	},
	{ additionalProperties: false, description: "Append content after a specific line (by anchor)" },
);
export const linePrependOp = Type.Object(
	{
		kind: Type.Literal("linePrepend"),
		target: filePathSchema,
		at: lineAnchorSchema,
		content: contentSchema,
	},
	{ additionalProperties: false, description: "Prepend content before a specific line (by anchor)" },
);
export const symbolReplaceOp = Type.Object(
	{
		kind: Type.Literal("symbolReplace"),
		target: symbolPathSchema,
		scope: Type.Optional(symScopeSchema),
		content: contentSchema,
	},
	{ additionalProperties: false, description: "Replace the body of a symbol with new content" },
);
export const symbolRenameOp = Type.Object(
	{
		kind: Type.Literal("symbolRename"),
		target: symbolPathSchema,
		newName: Type.String({ description: "New identifier name" }),
	},
	{ additionalProperties: false, description: "Rename a symbol throughout the file" },
);
export const symbolWrapOp = Type.Object(
	{
		kind: Type.Literal("symbolWrap"),
		target: symbolPathSchema,
		content: contentSchema,
	},
	{ additionalProperties: false, description: "Wrap a symbol with new content (e.g. add a function body)" },
);
export const symbolDeleteOp = Type.Object(
	{
		kind: Type.Literal("symbolDelete"),
		target: symbolPathSchema,
		allowSiblingDelete: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false, description: "Delete a symbol from its file" },
);
export const symbolInsertBeforeOp = Type.Object(
	{
		kind: Type.Literal("symbolInsertBefore"),
		target: symbolPathSchema,
		content: contentSchema,
	},
	{ additionalProperties: false, description: "Insert content before a symbol" },
);
export const symbolInsertAfterOp = Type.Object(
	{
		kind: Type.Literal("symbolInsertAfter"),
		target: symbolPathSchema,
		content: contentSchema,
	},
	{ additionalProperties: false, description: "Insert content after a symbol" },
);
export const symbolFindReplaceOp = Type.Object(
	{
		kind: Type.Literal("symbolFindReplace"),
		target: symbolPathSchema,
		find: contentSchema,
		content: contentSchema,
		occurrence: Type.Optional(occurrenceSchema),
	},
	{ additionalProperties: false, description: "Find-and-replace within a symbol using structural matching" },
);
export const symbolRawTextReplaceOp = Type.Object(
	{
		kind: Type.Literal("symbolRawTextReplace"),
		target: symbolPathSchema,
		find: contentSchema,
		content: contentSchema,
		occurrence: Type.Optional(occurrenceSchema),
	},
	{ additionalProperties: false, description: "Find-and-replace within a symbol using raw text matching" },
);
export const symbolMoveOp = Type.Object(
	{
		kind: Type.Literal("symbolMove"),
		target: symbolPathSchema,
		direction: directionSchema,
	},
	{ additionalProperties: false, description: "Move a symbol up or down within its file" },
);
export const symbolCloneOp = Type.Object(
	{
		kind: Type.Literal("symbolClone"),
		target: symbolPathSchema,
		renameTo: Type.Optional(Type.String({ description: "New identifier name" })),
	},
	{ additionalProperties: false, description: "Clone a symbol (optionally with a new name)" },
);
export const symbolSpliceOp = Type.Object(
	{
		kind: Type.Literal("symbolSplice"),
		target: symbolPathSchema,
		mode: spliceModeSchema,
	},
	{ additionalProperties: false, description: "Splice a node out of the tree, promoting or absorbing children" },
);
export const symbolTransposeOp = Type.Object(
	{
		kind: Type.Literal("symbolTranspose"),
		target: symbolPathSchema,
		column: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false, description: "Transpose a symbol to a different sibling position (1-indexed)" },
);
export const cssRenameClassTokenOp = Type.Object(
	{
		kind: Type.Literal("cssRenameClassToken"),
		target: symbolPathSchema,
		find: Type.String({ description: "New identifier name" }),
		replace: Type.String({ description: "New identifier name" }),
	},
	{ additionalProperties: false, description: "Rename a CSS class selector throughout the stylesheet" },
);
export const cssRenameIdTokenOp = Type.Object(
	{
		kind: Type.Literal("cssRenameIdToken"),
		target: symbolPathSchema,
		find: Type.String({ description: "New identifier name" }),
		replace: Type.String({ description: "New identifier name" }),
	},
	{ additionalProperties: false, description: "Rename a CSS id selector throughout the stylesheet" },
);
export const cssRenameCustomPropOp = Type.Object(
	{
		kind: Type.Literal("cssRenameCustomProp"),
		target: symbolPathSchema,
		find: Type.String({ description: "New identifier name" }),
		replace: Type.String({ description: "New identifier name" }),
	},
	{ additionalProperties: false, description: "Rename a CSS custom property throughout the stylesheet" },
);
export const cssRemoveDeadStyleOp = Type.Object(
	{
		kind: Type.Literal("cssRemoveDeadStyle"),
		target: symbolPathSchema,
	},
	{ additionalProperties: false, description: "Remove a dead/unused style rule from the stylesheet" },
);
export const headingPromoteOp = Type.Object(
	{
		kind: Type.Literal("headingPromote"),
		target: filePathSchema,
	},
	{ additionalProperties: false, description: "Promote a heading level (e.g. ## → #)" },
);
export const headingDemoteOp = Type.Object(
	{
		kind: Type.Literal("headingDemote"),
		target: filePathSchema,
	},
	{ additionalProperties: false, description: "Demote a heading level (e.g. # → ##)" },
);
export const headingReplaceBlockOp = Type.Object(
	{
		kind: Type.Literal("headingReplaceBlock"),
		target: filePathSchema,
		content: contentSchema,
	},
	{ additionalProperties: false, description: "Replace the content block under a heading" },
);

// ── Discriminated union of all Op variants ──

export const editOpSchema = Type.Union([
	fileCreateOp,
	fileWriteOp,
	fileDeleteOp,
	fileAppendOp,
	filePrependOp,
	filePatchOp,
	fileFindReplaceOp,
	fileRawTextReplaceOp,
	lineReplaceOp,
	lineInsertOp,
	lineAppendOp,
	linePrependOp,
	symbolReplaceOp,
	symbolRenameOp,
	symbolWrapOp,
	symbolDeleteOp,
	symbolInsertBeforeOp,
	symbolInsertAfterOp,
	symbolFindReplaceOp,
	symbolRawTextReplaceOp,
	symbolMoveOp,
	symbolCloneOp,
	symbolSpliceOp,
	symbolTransposeOp,
	cssRenameClassTokenOp,
	cssRenameIdTokenOp,
	cssRenameCustomPropOp,
	cssRemoveDeadStyleOp,
	headingPromoteOp,
	headingDemoteOp,
	headingReplaceBlockOp,
]);

export type EditOp = Static<typeof editOpSchema>;

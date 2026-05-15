import { type Static, Type } from "@sinclair/typebox";

// Re-export NAPI surface types
export type {
	CodePathChunk,
	CodePathOptions,
	ContentDto,
	DiagnosticDto,
	NodeRefDto,
	SpanDto,
} from "@oh-my-pi/pi-natives";

// ═══════════════════════════════════════════════════════════════════════════
// Shared action schema (used by edit and create)
// ═══════════════════════════════════════════════════════════════════════════

// ── Common field schemas ──

const filePathSchema = Type.String({
	pattern: "^[^:]*$|^[^:]*:[^:].*$",
	description: "Bare file path; MUST NOT contain '::' (symbol separator)",
});

const symbolPathSchema = Type.String({
	pattern: "^.+::.+$",
	description: "Symbol target; MUST contain '::Symbol[.member]'",
});

const contentSchema = Type.Union([Type.String(), Type.Array(Type.String())]);

const symScopeSchema = Type.Union([Type.Literal("whole"), Type.Literal("body"), Type.Literal("sig")]);

const occurrenceSchema = Type.Union([
	Type.Literal("first"),
	Type.Literal("last"),
	Type.Literal("all"),
	Type.Integer({ minimum: 1 }),
]);

const directionSchema = Type.Union([Type.Literal("up"), Type.Literal("down")]);
const spliceModeSchema = Type.Union([Type.Literal("self"), Type.Literal("up"), Type.Literal("down")]);

const lineAnchorSchema = Type.String({
	pattern: "^\\d+#.+$",
	description: "LINE#HASH anchor copied from get output (e.g. '42#ZP')",
});

const lineSpanSchema = Type.Object({
	start: lineAnchorSchema,
	end: Type.Optional(lineAnchorSchema),
});

const lineAtSchema = Type.Union([
	Type.Object({ side: Type.Literal("before"), anchor: lineAnchorSchema }),
	Type.Object({ side: Type.Literal("after"), anchor: lineAnchorSchema }),
]);

// ── Per-variant ops (new discriminated union) ──

export const fileCreateOp = Type.Object(
	{
		kind: Type.Literal("fileCreate"),
		target: filePathSchema,
		content: contentSchema,
		force: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false, description: "Create a new file; bare path; force=true overwrites" },
);

export const fileWriteOp = Type.Object(
	{
		kind: Type.Literal("fileWrite"),
		target: filePathSchema,
		content: contentSchema,
		force: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false, description: "Replace entire file content; bare path" },
);

export const fileDeleteOp = Type.Object(
	{
		kind: Type.Literal("fileDelete"),
		target: filePathSchema,
	},
	{ additionalProperties: false, description: "Delete file; bare path" },
);

export const fileAppendOp = Type.Object(
	{
		kind: Type.Literal("fileAppend"),
		target: filePathSchema,
		content: contentSchema,
	},
	{ additionalProperties: false },
);

export const filePrependOp = Type.Object(
	{
		kind: Type.Literal("filePrepend"),
		target: filePathSchema,
		content: contentSchema,
	},
	{ additionalProperties: false },
);

export const filePatchOp = Type.Object(
	{
		kind: Type.Literal("filePatch"),
		target: filePathSchema,
		diff: Type.String({ description: "Unified diff string" }),
	},
	{ additionalProperties: false },
);

export const lineReplaceOp = Type.Object(
	{
		kind: Type.Literal("lineReplace"),
		target: filePathSchema,
		span: lineSpanSchema,
		content: contentSchema,
	},
	{ additionalProperties: false },
);

export const lineInsertOp = Type.Object(
	{
		kind: Type.Literal("lineInsert"),
		target: filePathSchema,
		at: lineAtSchema,
		content: contentSchema,
	},
	{ additionalProperties: false },
);

export const lineAppendOp = Type.Object(
	{
		kind: Type.Literal("lineAppend"),
		target: filePathSchema,
		at: lineAnchorSchema,
		content: contentSchema,
	},
	{ additionalProperties: false },
);

export const linePrependOp = Type.Object(
	{
		kind: Type.Literal("linePrepend"),
		target: filePathSchema,
		at: lineAnchorSchema,
		content: contentSchema,
	},
	{ additionalProperties: false },
);

export const symbolReplaceOp = Type.Object(
	{
		kind: Type.Literal("symbolReplace"),
		target: symbolPathSchema,
		scope: Type.Optional(symScopeSchema),
		content: contentSchema,
	},
	{
		additionalProperties: false,
		description: "Replace symbol declaration; scope=whole|body|sig (default whole)",
	},
);

export const symbolRenameOp = Type.Object(
	{
		kind: Type.Literal("symbolRename"),
		target: symbolPathSchema,
		newName: Type.String(),
	},
	{ additionalProperties: false },
);

export const symbolWrapOp = Type.Object(
	{
		kind: Type.Literal("symbolWrap"),
		target: symbolPathSchema,
		content: contentSchema,
	},
	{ additionalProperties: false },
);

export const symbolDeleteOp = Type.Object(
	{
		kind: Type.Literal("symbolDelete"),
		target: symbolPathSchema,
		allowSiblingDelete: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export const symbolInsertBeforeOp = Type.Object(
	{
		kind: Type.Literal("symbolInsertBefore"),
		target: symbolPathSchema,
		content: contentSchema,
	},
	{ additionalProperties: false },
);

export const symbolInsertAfterOp = Type.Object(
	{
		kind: Type.Literal("symbolInsertAfter"),
		target: symbolPathSchema,
		content: contentSchema,
	},
	{ additionalProperties: false },
);

export const symbolFindReplaceOp = Type.Object(
	{
		kind: Type.Literal("symbolFindReplace"),
		target: symbolPathSchema,
		find: contentSchema,
		content: contentSchema,
		occurrence: Type.Optional(occurrenceSchema),
	},
	{ additionalProperties: false },
);

export const symbolRawTextReplaceOp = Type.Object(
	{
		kind: Type.Literal("symbolRawTextReplace"),
		target: symbolPathSchema,
		find: contentSchema,
		content: contentSchema,
		occurrence: Type.Optional(occurrenceSchema),
	},
	{ additionalProperties: false },
);

// File-scoped find/replace variants (PLAN-300 wave 3). Kernel `Op::from_legacy`
// routes `Action::FindAndReplace` to `Op::FileFindReplace` when the target has
// no `::Symbol` query segment; these schemas let agents address that path
// explicitly via the new-kind names instead of relying on the legacy alias.
export const fileFindReplaceOp = Type.Object(
	{
		kind: Type.Literal("fileFindReplace"),
		target: filePathSchema,
		find: contentSchema,
		content: contentSchema,
		occurrence: Type.Optional(occurrenceSchema),
	},
	{ additionalProperties: false },
);

export const fileRawTextReplaceOp = Type.Object(
	{
		kind: Type.Literal("fileRawTextReplace"),
		target: filePathSchema,
		find: contentSchema,
		content: contentSchema,
		occurrence: Type.Optional(occurrenceSchema),
	},
	{ additionalProperties: false },
);

export const symbolMoveOp = Type.Object(
	{
		kind: Type.Literal("symbolMove"),
		target: symbolPathSchema,
		direction: directionSchema,
	},
	{ additionalProperties: false },
);

export const symbolCloneOp = Type.Object(
	{
		kind: Type.Literal("symbolClone"),
		target: symbolPathSchema,
		renameTo: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const symbolSpliceOp = Type.Object(
	{
		kind: Type.Literal("symbolSplice"),
		target: symbolPathSchema,
		mode: spliceModeSchema,
	},
	{ additionalProperties: false },
);

export const symbolTransposeOp = Type.Object(
	{
		kind: Type.Literal("symbolTranspose"),
		target: symbolPathSchema,
		column: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

export const cssRenameClassTokenOp = Type.Object(
	{
		kind: Type.Literal("cssRenameClassToken"),
		target: Type.String(),
		find: Type.String(),
		replace: Type.String(),
	},
	{ additionalProperties: false },
);

export const cssRenameIdTokenOp = Type.Object(
	{
		kind: Type.Literal("cssRenameIdToken"),
		target: Type.String(),
		find: Type.String(),
		replace: Type.String(),
	},
	{ additionalProperties: false },
);

export const cssRenameCustomPropOp = Type.Object(
	{
		kind: Type.Literal("cssRenameCustomProp"),
		target: Type.String(),
		find: Type.String(),
		replace: Type.String(),
	},
	{ additionalProperties: false },
);

export const cssRemoveDeadStyleOp = Type.Object(
	{
		kind: Type.Literal("cssRemoveDeadStyle"),
		target: Type.String(),
	},
	{ additionalProperties: false },
);

export const headingPromoteOp = Type.Object(
	{
		kind: Type.Literal("headingPromote"),
		target: Type.String(),
	},
	{ additionalProperties: false },
);

export const headingDemoteOp = Type.Object(
	{
		kind: Type.Literal("headingDemote"),
		target: Type.String(),
	},
	{ additionalProperties: false },
);

export const headingReplaceBlockOp = Type.Object(
	{
		kind: Type.Literal("headingReplaceBlock"),
		target: Type.String(),
		content: contentSchema,
	},
	{ additionalProperties: false },
);

// ── Legacy action shape (flat bag-of-fields, for backward compatibility) ──
// Keep this for tests and legacy adapter typing.

export const legacyActionSchema = Type.Object(
	{
		kind: Type.String({
			description:
				"Action kind: write | findAndReplace | rawTextReplace | wrap | rename | delete | insertBefore | insertAfter | splice | move | clone | transpose | renameClassToken | renameIdToken | renameCustomProperty | removeDeadStyle | promote | demote | replaceCodeBlock | replace | append | prepend | patch | create",
		}),
		scope: Type.Optional(Type.String({ description: "Write scope: target | body" })),
		content: Type.Optional(
			Type.Union([Type.String(), Type.Array(Type.String())], {
				description: "Canonical content payload for write-like actions",
			}),
		),
		find: Type.Optional(
			Type.Union([Type.String(), Type.Array(Type.String())], {
				description: "Find text for findAndReplace within the resolved target scope",
			}),
		),
		mode: Type.Optional(Type.String({ description: "Splice mode: self | up | down (default: self)" })),
		direction: Type.Optional(Type.String({ description: "Move direction: up | down" })),
		line: Type.Optional(
			Type.Integer({ description: "1-indexed line for positional actions when needed", minimum: 1 }),
		),
		column: Type.Optional(Type.Integer({ description: "1-indexed column for transpose actions when needed" })),
		nodeType: Type.Optional(Type.String({ description: "Optional node type hint for positional actions" })),
		allowSiblingDelete: Type.Optional(
			Type.Boolean({ description: "Allow sibling deletion when structural matching proves it safe" }),
		),
		occurrence: Type.Optional(
			Type.Union([Type.Literal("first"), Type.Literal("last"), Type.Literal("all"), Type.Integer({ minimum: 1 })], {
				description: "Match occurrence selector: first | last | all | 1-indexed number",
			}),
		),
		// LINE#ID fields
		pos: Type.Optional(
			Type.String({
				description:
					'Start anchor in LINE#ID format copied from read output (e.g. "5#QW"). Supported on replace, append, prepend, insertBefore, insertAfter, and splice. A single anchor (pos or end, but not both) replaces exactly one line; lines.length does not control span.',
			}),
		),
		end: Type.Optional(
			Type.String({
				description:
					"End anchor in LINE#ID format copied from read output (optional range end; when both pos and end are set they define a multi-line range).",
			}),
		),
		lines: Type.Optional(
			Type.Union([
				Type.Array(Type.String()),
				Type.String({ description: "Replacement content as a newline-delimited string" }),
				Type.Null({ description: "Delete the targeted content" }),
			]),
		),
		// Patch fields
		diff: Type.Optional(Type.String({ description: "Unified diff string for patch action" })),
		// Create fields
		force: Type.Optional(Type.Boolean({ description: "Overwrite existing file" })),
	},
	{ additionalProperties: false },
);

export type LegacyAction = Static<typeof legacyActionSchema>;

// ── Union of all new Op variants ──

export const editOpSchema = Type.Union([
	fileCreateOp,
	fileWriteOp,
	fileDeleteOp,
	fileAppendOp,
	filePrependOp,
	filePatchOp,
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
	fileFindReplaceOp,
	fileRawTextReplaceOp,
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

// ── Public alias for backward compat ──
export const codePathActionSchema = legacyActionSchema;
export type CodePathAction = LegacyAction;

// ═══════════════════════════════════════════════════════════════════════════
// Get tool schema
// ═══════════════════════════════════════════════════════════════════════════

export const getSchema = Type.Object(
	{
		target: Type.String({
			description:
				'Path · glob · symbol · slice · URI. Multi-word symbols backtick-quoted: foo.ts::`export * from "./json"`. See tool description for grammar.',
		}),
		format: Type.Optional(
			Type.String({
				description: "Output format: node-list | locations | content-only | tree | simple-list | fs-listing",
			}),
		),
		root: Type.Optional(
			Type.String({ description: "Optional project-relative or absolute root for target resolution" }),
		),
		content: Type.Optional(
			Type.Boolean({
				description: "Return metadata only (size, symbols, anchors) when false; default true.",
			}),
		),
		recursive: Type.Optional(Type.Boolean({ description: "Recurse into subdirectories (default: false)" })),
		depth: Type.Optional(Type.Integer({ description: "Max recursion depth (1 = one level, overrides recursive)" })),
		gitignore: Type.Optional(
			Type.Boolean({ description: "Skip .gitignored paths; default true. Set false to read gitignored files." }),
		),
	},
	{ additionalProperties: false },
);

export type GetParams = Static<typeof getSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Find tool schema — single CodePath target, no params.
// All output shape (content vs locations vs stat vs diff vs tree) is inferred
// from the target's query/qualifier. The kernel is the sole authority on
// what the target expresses; the TS surface is a pure envelope.
// ═══════════════════════════════════════════════════════════════════════════

export const findSchema = Type.Object(
	{
		target: Type.String({
			description:
				"CodePath: path · glob · symbol · slice · URI. Examples: 'foo.ts', 'foo.ts:80-130', 'src/**/*.ts::§line[text~=\"TODO\"]', 'foo.ts::Bar.method#body', 'foo.ts::Bar.method def→', 'foo.ts#stat', 'foo.ts#diff', 'src/#tree', 'memory://root'. See find tool prompt for grammar.",
		}),
	},
	{ additionalProperties: false },
);

export type FindParams = Static<typeof findSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Edit tool schema
// ═══════════════════════════════════════════════════════════════════════════

export const editOperationSchema = Type.Recursive(This =>
	Type.Object(
		{
			target: Type.String({
				description:
					"Stable edit target ID: '<file>' for file roots or '<file>::Symbol.member' for declarations. Multi-word symbols may be backtick-quoted, e.g. foo.ts::`export * from \"./json\"`",
			}),
			action: codePathActionSchema,
			children: Type.Optional(
				Type.Array(This, { description: "Nested child target operations under the same file tree" }),
			),
			occurrence: Type.Optional(
				Type.Union(
					[Type.Literal("first"), Type.Literal("last"), Type.Literal("all"), Type.Integer({ minimum: 1 })],
					{
						description: "Match occurrence selector: first | last | all | 1-indexed number",
					},
				),
			),
			idempotent: Type.Optional(
				Type.Boolean({
					description: "Allow mutating edit commands to succeed when they intentionally make no semantic change",
				}),
			),
		},
		{ additionalProperties: false },
	),
);

export const editSchema = Type.Object(
	{
		operations: Type.Array(editOperationSchema, { description: "Ordered edit operations" }),
		root: Type.Optional(
			Type.String({ description: "Optional project-relative or absolute root for target resolution" }),
		),
		idempotent: Type.Optional(
			Type.Boolean({
				description: "Allow mutating edit commands to succeed when they intentionally make no semantic change",
			}),
		),
		transaction: Type.Optional(
			Type.Union([Type.Literal("best-effort"), Type.Literal("strict")], {
				description:
					"Batch transaction mode. 'best-effort' (default): on failure, applied ops stay applied and remaining ops are skipped. 'strict': snapshot all target files before any op; on any failure, restore snapshots (and unlink files that did not exist before) and report rollback.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type EditOperation = Static<typeof editOperationSchema>;
export type EditParams = Static<typeof editSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Manage tool schema
// ═══════════════════════════════════════════════════════════════════════════

export const manageSchema = Type.Object(
	{
		command: Type.Union([
			Type.Literal("save"),
			Type.Literal("undo"),
			Type.Literal("redo"),
			Type.Literal("diff"),
			Type.Literal("buffers"),
			Type.Literal("languages"),
			Type.Literal("index"),
			Type.Literal("watcherStatus"),
			Type.Literal("lockStatus"),
			Type.Literal("status"),
			Type.Literal("context"),
		]),
		file: Type.Optional(Type.String({ description: "File path for file-scoped management commands" })),
	},
	{ additionalProperties: false },
);

export type ManageParams = Static<typeof manageSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Status tool schema — kernel observability only.
// Drops save/undo/redo/diff/buffers/context vs manage:
//   save    — edits auto-persist (no buffer surface)
//   undo    — moved to edit tool (kind: "undo")
//   redo    — moved to edit tool (kind: "redo")
//   diff    — use `find { target: "#diff" }` (post-kernel-rebuild)
//   buffers — no buffer surface
//   context — agent-side
// ═══════════════════════════════════════════════════════════════════════════

export const statusSchema = Type.Object(
	{
		command: Type.Union([
			Type.Literal("languages"),
			Type.Literal("index"),
			Type.Literal("watcherStatus"),
			Type.Literal("lockStatus"),
			Type.Literal("status"),
		]),
		file: Type.Optional(Type.String({ description: "File path for file-scoped commands" })),
	},
	{ additionalProperties: false },
);

export type StatusParams = Static<typeof statusSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Create tool schema
// ═══════════════════════════════════════════════════════════════════════════

export const createContentSchema = Type.Union([
	Type.String({ description: "Text content for the new file" }),
	Type.Object(
		{
			kind: Type.Literal("bytes"),
			artifactUri: Type.String({ description: "Artifact URI to read bytes from" }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("base64"),
			data: Type.String({ description: "Base64-encoded file content" }),
		},
		{ additionalProperties: false },
	),
]);

export const createSchema = Type.Object(
	{
		path: Type.String({ description: "File path (relative or absolute)" }),
		content: createContentSchema,
		force: Type.Optional(Type.Boolean({ description: "Overwrite existing file" })),
	},
	{ additionalProperties: false },
);

export type CreateParams = Static<typeof createSchema>;

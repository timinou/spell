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

// Schema primitives moved to ./codepath-primitives to break circular imports
// (codepath-op-schema.generated.ts depends on them; if they lived here, this
//  file's re-export of the generated schemas would create a cycle).
export {
	contentSchema,
	directionSchema,
	filePathSchema,
	lineAnchorSchema,
	lineAtSchema,
	lineSpanSchema,
	occurrenceSchema,
	spliceModeSchema,
	symbolPathSchema,
	symScopeSchema,
} from "./codepath-primitives";

// ── Per-variant Op schemas + editOpSchema + EditOp type are GENERATED ──
// Source: kernel Op enum via list_ops() NAPI introspection.
// Refresh: `bun run gen:op-schema`. See codepath-op-schema.generated.ts.

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

// ── Re-export generated Op schemas (kernel-derived) ──
export {
	cssRemoveDeadStyleOp,
	cssRenameClassTokenOp,
	cssRenameCustomPropOp,
	cssRenameIdTokenOp,
	editOpSchema,
	fileAppendOp,
	fileCreateOp,
	fileDeleteOp,
	fileFindReplaceOp,
	filePatchOp,
	filePrependOp,
	fileRawTextReplaceOp,
	fileWriteOp,
	headingDemoteOp,
	headingPromoteOp,
	headingReplaceBlockOp,
	lineAppendOp,
	lineInsertOp,
	linePrependOp,
	lineReplaceOp,
	symbolCloneOp,
	symbolDeleteOp,
	symbolFindReplaceOp,
	symbolInsertAfterOp,
	symbolInsertBeforeOp,
	symbolMoveOp,
	symbolRawTextReplaceOp,
	symbolRenameOp,
	symbolReplaceOp,
	symbolSpliceOp,
	symbolTransposeOp,
	symbolWrapOp,
} from "./codepath-op-schema.generated";
export type { EditOp } from "./codepath-op-schema.generated";

// Backward compat alias (still used by editSchema's union for legacy adapter input).
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

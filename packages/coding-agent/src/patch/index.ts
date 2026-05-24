/**
 * Edit tool module.
 *
 * Supports three modes:
 * - Replace mode (default): oldText/newText replacement with fuzzy matching
 * - Patch mode: structured diff format with explicit operation type
 * - Hashline mode: line-addressed edits using content hashes for integrity
 *
 * The mode is determined by the `edit.mode` setting.
 */
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { StringEnum } from "@oh-my-pi/pi-ai";
import { type Static, Type } from "@sinclair/typebox";
import { renderPromptTemplate } from "../config/prompt-templates";
import {
	createLspWritethrough,
	type FileDiagnosticsResult,
	flushLspWritethroughBatch,
	type WritethroughCallback,
	writethroughNoop,
} from "../lsp";

import patchDescription from "../prompts/tools/patch.md" with { type: "text" };
import replaceDescription from "../prompts/tools/replace.md" with { type: "text" };
import { enforcePathWrite } from "../sandbox";
import type { ToolSession } from "../tools";
import { isCodeToolSupportedPath } from "../tools/code-supported-files";
import { formatCodeTextCompatibilityNotice } from "../tools/code-text-compatibility";
import {
	invalidateFsScanAfterDelete,
	invalidateFsScanAfterRename,
	invalidateFsScanAfterWrite,
} from "../tools/fs-cache-invalidation";
import {
	applyManagedBufferContent,
	ensureManagedBufferFresh,
	invalidateManagedCodeBuffersForPaths,
} from "../tools/managed-code-buffer";
import { enforceModeWrite, resolvePlanPath } from "../tools/mode-guard";
import { outputMeta } from "../tools/output-meta";
import { applyPatch } from "./applicator";
import { generateDiffString, generateUnifiedDiffString, replaceText } from "./diff";
import { findMatch } from "./fuzzy";
import {
	type Anchor,
	applyHashlineEdits,
	buildCompactHashlineDiffPreview,
	computeLineHash,
	type HashlineEdit,
	MalformedHashlineAnchorError,
	MissingHashlineAnchorError,
	parseTag,
	SpanMismatchHashlineAnchorError,
} from "./hashline";
import { detectLineEnding, normalizeToLF, restoreLineEndings, stripBom } from "./normalize";
import { type EditToolDetails, getLspBatchRequest } from "./shared";
// Internal imports
import type { FileSystem, Operation, PatchInput } from "./types";
import { EditMatchError } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Re-exports
// ═══════════════════════════════════════════════════════════════════════════

// Application
export { applyPatch, defaultFileSystem, previewPatch } from "./applicator";
// Diff generation
export * from "./diff";

// Fuzzy matching
export * from "./fuzzy";
// Hashline
export * from "./hashline";
// Normalization
export * from "./normalize";
// Parsing
export {
	normalizeCreateContent,
	normalizeDiff,
	parseHunks as parseDiffHunks,
} from "./parser";
export type { EditRenderContext, EditToolDetails } from "./shared";
// Rendering
export { editToolRenderer, getLspBatchRequest } from "./shared";
export * from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Schemas
// ═══════════════════════════════════════════════════════════════════════════

const replaceEditSchema = Type.Object({
	path: Type.String({ description: "File path (relative or absolute)" }),
	old_text: Type.String({
		description: "Text to find (fuzzy whitespace matching enabled)",
	}),
	new_text: Type.String({ description: "Replacement text" }),
	all: Type.Optional(
		Type.Boolean({
			description: "Replace all occurrences (default: unique match required)",
		}),
	),
});

const patchEditSchema = Type.Object({
	path: Type.String({ description: "File path" }),
	op: Type.Optional(
		StringEnum(["create", "delete", "update"], {
			description: "Operation (default: update)",
		}),
	),
	rename: Type.Optional(Type.String({ description: "New path for move" })),
	diff: Type.Optional(
		Type.String({
			description: "Diff hunks (update) or full content (create)",
		}),
	),
});

export type ReplaceParams = Static<typeof replaceEditSchema>;
export type PatchParams = Static<typeof patchEditSchema>;

/** Pattern matching hashline display format prefixes: `LINE#ID:CONTENT` and `#ID:CONTENT` */
const HASHLINE_PREFIX_RE = /^\s*(?:>>>|>>)?\s*(?:\d+\s*#\s*|#\s*)[ZPMQVRWSNKTXJBYH]{2}:/;

/** Pattern matching a unified-diff added-line `+` prefix (but not `++`). Does NOT match `-` to avoid corrupting Markdown list items. */
const DIFF_PLUS_RE = /^[+](?![+])/;

/**
 * Strip hashline display prefixes and diff `+` markers from replacement lines.
 *
 * Models frequently copy the `LINE#ID  ` prefix from read output into their
 * replacement content, or include unified-diff `+` prefixes. Both corrupt the
 * output file. This strips them heuristically before application.
 */
export function stripNewLinePrefixes(lines: string[]): string[] {
	// Hashline prefixes are highly specific to read output and should only be
	// stripped when *every* non-empty line carries one.
	// Diff '+' markers can be legitimate content less often, so keep majority mode.
	let hashPrefixCount = 0;
	let diffPlusCount = 0;
	let nonEmpty = 0;
	for (const l of lines) {
		if (l.length === 0) continue;
		nonEmpty++;
		if (HASHLINE_PREFIX_RE.test(l)) hashPrefixCount++;
		if (DIFF_PLUS_RE.test(l)) diffPlusCount++;
	}
	if (nonEmpty === 0) return lines;

	const stripHash = hashPrefixCount > 0 && hashPrefixCount === nonEmpty;
	const stripPlus = !stripHash && diffPlusCount > 0 && diffPlusCount >= nonEmpty * 0.5;
	if (!stripHash && !stripPlus) return lines;

	return lines.map(l => {
		if (stripHash) return l.replace(HASHLINE_PREFIX_RE, "");
		if (stripPlus) return l.replace(DIFF_PLUS_RE, "");
		return l;
	});
}

export function hashlineParseText(edit: string[] | string | null): string[] {
	if (edit === null) return [];
	if (typeof edit === "string") {
		const normalizedEdit = edit.endsWith("\n") ? edit.slice(0, -1) : edit;
		edit = normalizedEdit.replaceAll("\r", "").split("\n");
	}
	return stripNewLinePrefixes(edit);
}

const hashlineEditSchema = Type.Object(
	{
		op: StringEnum(["replace", "append", "prepend"], {
			description: "Edit operation: replace, append, or prepend",
		}),
		pos: Type.Optional(
			Type.String({
				description:
					"Start anchor in LINE#ID format copied from read output. A single anchor (pos or end, but not both) replaces exactly one line; lines.length does not control span.",
			}),
		),
		end: Type.Optional(
			Type.String({
				description:
					"End anchor in LINE#ID format copied from read output (optional range end; when both pos and end are set they define a multi-line range).",
			}),
		),
		lines: Type.Union([
			Type.Array(Type.String(), {
				description:
					"Replacement content. Must be length 1 when only one anchor is supplied, since a single anchor replaces exactly one line.",
			}),
			Type.String({ description: "Replacement content as a newline-delimited string" }),
			Type.Null({ description: "Delete the targeted content" }),
		]),
	},
	{ additionalProperties: false },
);

const hashlineEditParamsSchema = Type.Object(
	{
		path: Type.String({ description: "File path (relative or absolute)" }),
		edits: Type.Array(hashlineEditSchema, {
			description:
				"Ordered hashline edits over $path. replace must include pos or end; anchorless append/prepend insert at file start/end.",
		}),
		delete: Type.Optional(Type.Boolean({ description: "If true, delete $path" })),
		move: Type.Optional(Type.String({ description: "If set, move $path to $move" })),
	},
	{ additionalProperties: false },
);

export type HashlineToolEdit = Static<typeof hashlineEditSchema>;
export type HashlineParams = Static<typeof hashlineEditParamsSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Strict anchor resolution
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Map flat tool-schema edits (pos/end) into typed HashlineEdit objects.
 *
 * Strict: supplied anchors must parse exactly as LINE#ID tags from read output.
 * - replace requires at least one anchor
 * - append/prepend may omit anchors for file-level insertions
 * - invalid pos/end never fall back to the other anchor
 *
 * Unknown ops default to "replace".
 */
export function resolveEditAnchors(edits: HashlineToolEdit[]): HashlineEdit[] {
	const result: HashlineEdit[] = [];
	for (const [index, edit] of edits.entries()) {
		const editIndex = index + 1;
		const lines = hashlineParseText(edit.lines);
		// Normalize op — default unknown values to "replace"
		const op = edit.op === "append" || edit.op === "prepend" ? edit.op : "replace";
		const pos = edit.pos !== undefined ? parseHashlineAnchor(edit.pos, "pos", editIndex) : undefined;
		const end = edit.end !== undefined ? parseHashlineAnchor(edit.end, "end", editIndex) : undefined;

		switch (op) {
			case "replace": {
				if (pos && end) {
					result.push({ op: "replace", pos, end, lines });
				} else if (pos || end) {
					const singleAnchor = pos || end!;
					const field = pos ? "pos" : "end";
					if (lines.length > 1) {
						throw new SpanMismatchHashlineAnchorError(editIndex, field, lines.length);
					}
					result.push({ op: "replace", pos: singleAnchor, lines });
				} else {
					throw new MissingHashlineAnchorError(editIndex);
				}
				break;
			}
			case "append": {
				result.push({ op: "append", pos: pos ?? end, lines });
				break;
			}
			case "prepend": {
				result.push({ op: "prepend", pos: end ?? pos, lines });
				break;
			}
		}
	}
	return result;
}

function parseHashlineAnchor(raw: string, field: "pos" | "end", editIndex: number): Anchor {
	try {
		return parseTag(raw);
	} catch (error) {
		throw new MalformedHashlineAnchorError(
			editIndex,
			field,
			raw,
			error instanceof Error ? error.message : String(error),
		);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// LSP FileSystem for patch mode
// ═══════════════════════════════════════════════════════════════════════════

class LspFileSystem implements FileSystem {
	#lastDiagnostics: FileDiagnosticsResult | undefined;
	#fileCache: Record<string, Bun.BunFile> = {};

	constructor(
		private readonly writethrough: (
			dst: string,
			content: string,
			signal?: AbortSignal,
			file?: import("bun").BunFile,
			batch?: { id: string; flush: boolean },
		) => Promise<FileDiagnosticsResult | undefined>,
		private readonly signal?: AbortSignal,
		private readonly batchRequest?: { id: string; flush: boolean },
	) {}

	#getFile(path: string): Bun.BunFile {
		if (this.#fileCache[path]) {
			return this.#fileCache[path];
		}
		const file = Bun.file(path);
		this.#fileCache[path] = file;
		return file;
	}

	async exists(path: string): Promise<boolean> {
		return this.#getFile(path).exists();
	}

	async read(path: string): Promise<string> {
		return this.#getFile(path).text();
	}

	async readBinary(path: string): Promise<Uint8Array> {
		const buffer = await this.#getFile(path).arrayBuffer();
		return new Uint8Array(buffer);
	}

	async write(path: string, content: string): Promise<void> {
		const file = this.#getFile(path);
		const result = await this.writethrough(path, content, this.signal, file, this.batchRequest);
		if (result) {
			this.#lastDiagnostics = result;
		}
	}

	async delete(path: string): Promise<void> {
		await this.#getFile(path).unlink();
	}

	async mkdir(path: string): Promise<void> {
		await fs.mkdir(path, { recursive: true });
	}

	getDiagnostics(): FileDiagnosticsResult | undefined {
		return this.#lastDiagnostics;
	}
}

function mergeDiagnosticsWithWarnings(
	diagnostics: FileDiagnosticsResult | undefined,
	warnings: string[],
): FileDiagnosticsResult | undefined {
	if (warnings.length === 0) return diagnostics;
	const warningMessages = warnings.map(warning => `patch: ${warning}`);
	if (!diagnostics) {
		return {
			server: "patch",
			messages: warningMessages,
			summary: `Patch warnings: ${warnings.length}`,
			errored: false,
		};
	}
	return {
		...diagnostics,
		messages: [...warningMessages, ...diagnostics.messages],
		summary: `${diagnostics.summary}; Patch warnings: ${warnings.length}`,
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Class
// ═══════════════════════════════════════════════════════════════════════════

export type EditMode = "replace" | "patch" | "hashline";

const EDIT_MODES = ["replace", "patch", "hashline"] as const satisfies readonly EditMode[];
const EDIT_ID = Object.fromEntries(EDIT_MODES.map(mode => [mode, mode])) satisfies Record<string, EditMode>;
export const normalizeEditMode = (mode?: string | null): EditMode | undefined => EDIT_ID[mode ?? ""];
